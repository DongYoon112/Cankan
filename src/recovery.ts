// Reconciles by GET only; PostgreSQL leases fence every observation and never alter spending.
import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';
import { canonicalSchema, fingerprint, outcomeSchema, verifiedReceipt, type Receipt, type CanonicalInput } from './shared.js';

export const recoveryLimits = { concurrency: 4, leaseSeconds: 15, timeoutMs: 2500, maxLookups: 8 } as const;
export type RecoveryClaim = {
  operation_id: string; provider_operation_id: string; input: CanonicalInput; fingerprint: string;
  generation: number; version: number; lookup_count: number;
};
type Attempt = { state: 'unresolved' | 'succeeded'; evidence: Receipt | null; version: number };
export async function lockAttempt(client: PoolClient, id: string): Promise<Attempt | undefined> {
  return (await client.query<Attempt>('SELECT state,evidence,version FROM attempts WHERE operation_id=$1 FOR UPDATE', [id])).rows[0];
}
export async function observe(client: PoolClient, id: string, generation: number, source: 'lookup' | 'kaji', code: string, evidence: unknown = null) {
  await client.query(`INSERT INTO reconciliation_observations(operation_id,generation,source,code,evidence)
    VALUES ($1,$2,$3,$4,$5)`, [id, generation, source, code, evidence]);
}
// Caller holds the attempt lock. Identical evidence is harmless; accepted success never changes.
export async function acceptReceipt(client: PoolClient, id: string, attempt: Attempt, receipt: Receipt): Promise<boolean> {
  if (attempt.state === 'succeeded') return fingerprint(attempt.evidence) === fingerprint(receipt);
  const updated = await client.query(`UPDATE attempts SET state='succeeded',evidence=$2,finished_at=clock_timestamp(),version=version+1
    WHERE operation_id=$1 AND state='unresolved' AND version=$3`, [id, receipt, attempt.version]);
  if (updated.rowCount !== 1) throw new Error('Attempt version changed');
  return true;
}
export async function resolveJob(client: PoolClient, id: string) {
  await client.query(`UPDATE reconciliation_jobs SET state='resolved',lease_until=NULL,next_check_at=NULL,last_error=NULL
    WHERE operation_id=$1`, [id]);
}

export async function claimRecovery(pool: Pool): Promise<RecoveryClaim | undefined> {
  return transaction(pool, async client => {
    const row = (await client.query<RecoveryClaim>(`SELECT j.operation_id,j.generation,j.lookup_count,a.version,
      o.provider_operation_id,o.input,o.fingerprint FROM reconciliation_jobs j
      JOIN attempts a ON a.operation_id=j.operation_id JOIN operations o ON o.id=j.operation_id
      WHERE a.state='unresolved' AND j.state IN ('pending','leased') AND j.next_check_at<=clock_timestamp()
        AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
      ORDER BY j.next_check_at,j.operation_id LIMIT 1 FOR UPDATE OF a,j SKIP LOCKED`)).rows[0];
    if (!row) return undefined;
    if (row.lookup_count >= recoveryLimits.maxLookups) {
      await client.query(`UPDATE reconciliation_jobs SET state='attention',lease_until=NULL,next_check_at=NULL,
        last_error='retry_exhausted' WHERE operation_id=$1`, [row.operation_id]);
      await observe(client, row.operation_id, row.generation, 'lookup', 'retry_exhausted');
      return undefined;
    }
    const job = (await client.query<{ generation: number; lookup_count: number }>(`UPDATE reconciliation_jobs
      SET state='leased',generation=generation+1,lookup_count=lookup_count+1,
        lease_until=clock_timestamp()+make_interval(secs=>$2)
      WHERE operation_id=$1 RETURNING generation,lookup_count`, [row.operation_id, recoveryLimits.leaseSeconds])).rows[0]!;
    return { ...row, ...job };
  });
}

export type Observation = { code: string; receipt?: Receipt; diagnostic?: unknown };
export async function lookupOutcome(claim: RecoveryClaim, providerUrl: string, lookupToken: string): Promise<Observation> {
  let input: CanonicalInput;
  try {
    input = canonicalSchema.parse(claim.input);
    if (fingerprint(input) !== claim.fingerprint) throw new Error('Invalid input');
  } catch { return { code: 'saved_input_invalid' }; }
  try {
    const response = await fetch(new URL(`/organizations/${input.organizationId}/operations/${claim.provider_operation_id}`, providerUrl), {
      headers: { authorization: `Bearer ${lookupToken}` }, signal: AbortSignal.timeout(recoveryLimits.timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return response.status === 404 ? { code: 'not_found' } : { code: 'lookup_unavailable', diagnostic: { status: response.status } };
    }
    // Bound untrusted response memory and keep timeout active through body reading.
    let body = '';
    if (!response.body) return { code: 'malformed_evidence' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) { await reader.cancel(); return { code: 'malformed_evidence' }; }
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    let value: unknown;
    try { value = JSON.parse(body); } catch { return { code: 'malformed_evidence' }; }
    const parsed = outcomeSchema.safeParse(value);
    if (!parsed.success) return { code: 'malformed_evidence', diagnostic: { fingerprint: fingerprint(value) } };
    try {
      if (parsed.data.organizationId !== input.organizationId || fingerprint(parsed.data.quote) !== fingerprint(input.quote))
        throw new Error('Binding mismatch');
      return { code: 'confirmed', receipt: verifiedReceipt(parsed.data.receipt, input, claim.provider_operation_id) };
    } catch { return { code: 'mismatched_evidence', diagnostic: parsed.data }; }
  } catch { return { code: 'lookup_unavailable' }; }
}

export async function saveObservation(pool: Pool, claim: RecoveryClaim, observation: Observation): Promise<boolean> {
  return transaction(pool, async client => {
    const attempt = await lockAttempt(client, claim.operation_id);
    if (!attempt) return false;
    await client.query('SELECT 1 FROM reconciliation_jobs WHERE operation_id=$1 FOR UPDATE', [claim.operation_id]);
    // Check database time after all lock waits; even an expired sole worker cannot write.
    const owned = await client.query(`SELECT 1 FROM reconciliation_jobs WHERE operation_id=$1 AND generation=$2
      AND state='leased' AND lease_until>clock_timestamp()`, [claim.operation_id, claim.generation]);
    if (!owned.rowCount || attempt.state !== 'unresolved' || attempt.version !== claim.version) return false;
    let receipt: Receipt | undefined;
    if (observation.receipt) receipt = verifiedReceipt(observation.receipt, claim.input, claim.provider_operation_id);
    const code = receipt ? 'confirmed' : observation.code;
    const exhausted = claim.lookup_count >= recoveryLimits.maxLookups;
    const updated = await client.query(`UPDATE reconciliation_jobs SET state=$3,lease_until=NULL,
      last_check_at=clock_timestamp(),last_error=$4,
      next_check_at=CASE WHEN $3='pending' THEN clock_timestamp()+make_interval(secs=>$5) ELSE NULL END
      WHERE operation_id=$1 AND generation=$2 AND state='leased' AND lease_until>clock_timestamp() RETURNING operation_id`,
    [claim.operation_id, claim.generation, receipt ? 'resolved' : exhausted ? 'attention' : 'pending',
      receipt ? null : code, Math.min(300, 5 * 2 ** (claim.lookup_count - 1))]);
    if (!updated.rowCount) return false;
    if (receipt) await acceptReceipt(client, claim.operation_id, attempt, receipt);
    await observe(client, claim.operation_id, claim.generation, 'lookup', code, receipt ?? observation.diagnostic ?? null);
    return true;
  });
}

// One bounded batch per pass; the background entrypoint repeats passes.
export async function reconcileOnce(pool: Pool, providerUrl: string, lookupToken: string): Promise<number> {
  const results = await Promise.all(Array.from({ length: recoveryLimits.concurrency }, async () => {
    const claim = await claimRecovery(pool);
    if (!claim) return 0;
    return await saveObservation(pool, claim, await lookupOutcome(claim, providerUrl, lookupToken)) ? 1 : 0;
  }));
  return results.reduce<number>((sum, value) => sum + value, 0);
}
