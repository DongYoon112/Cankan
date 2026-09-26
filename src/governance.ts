// Authenticates action requests and coordinates policy, budget, dispatch, and durable Kaji execution.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { capability, createKaji, type ExecutionStore, type ExecutionClaim, type ClaimResult, type StoredExecution } from '@irogane/kaji';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from './db.js';
import { HttpError, json, readJson, serve } from './http.js';
import { canonicalSchema, fingerprint, identifier, quoteSchema, receiptSchema, requestSchema, tokenHash, type CanonicalInput } from './shared.js';

type Principal = { id: string; org_id: string; role: 'agent' | 'owner' };
type Operation = {
  id: string; org_id: string; principal_id: string; operation_key: string;
  provider_operation_id: string; input: CanonicalInput; request: z.infer<typeof requestSchema>; fingerprint: string;
};
type Decision = { allowed: boolean; reason: string; requires_approval: boolean };
type ExecutionRow = { id: string; operation_id: string; capability: string; principal_id: string;
  idempotency_key: string; input_fingerprint: string; outcome: StoredExecution | null };

// Application-specific store: Kaji's claim and our dispatch cutoff share one commit.
export class PgExecutionStore implements ExecutionStore {
  constructor(private readonly pool: Pool, private readonly operation: Operation) {}

  async claim(claim: ExecutionClaim): Promise<ClaimResult> {
    const op = this.operation;
    if (claim.capability !== op.input.action || claim.principalId !== op.principal_id || claim.idempotencyKey !== op.provider_operation_id)
      throw new Error('Claim identity mismatch');
    const result = await transaction(this.pool, async client => {
      // ponytail: purchases serialize per organization; narrow locking if measured throughput needs it.
      const org = (await client.query('SELECT paused FROM organizations WHERE id=$1 FOR NO KEY UPDATE', [op.org_id])).rows[0];
      const task = (await client.query('SELECT * FROM tasks WHERE id=$1 AND org_id=$2 FOR NO KEY UPDATE', [op.input.taskId, op.org_id])).rows[0];
      const principal = (await client.query('SELECT active FROM principals WHERE id=$1 AND org_id=$2 FOR NO KEY UPDATE', [op.principal_id, op.org_id])).rows[0];
      const inserted = await client.query<ExecutionRow>(`INSERT INTO executions
        (id,operation_id,capability,principal_id,idempotency_key,input_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,
      [randomUUID(), op.id, claim.capability, claim.principalId, claim.idempotencyKey, claim.inputFingerprint]);
      if (!inserted.rowCount) {
        const existing = (await client.query<ExecutionRow>('SELECT * FROM executions WHERE operation_id=$1', [op.id])).rows[0];
        if (!existing) throw new Error('Missing execution');
        return { row: existing, fresh: false };
      }
      const row = inserted.rows[0]!;
      // Read time after row-lock waits, which may outlast the quote.
      const membership = await client.query('SELECT clock_timestamp() AS db_now FROM task_agents WHERE task_id=$1 AND principal_id=$2 AND org_id=$3', [op.input.taskId, op.principal_id, op.org_id]);
      const quote = op.input.quote;
      const total = quote.amountCents + quote.feeCents;
      const reason = !principal?.active ? 'principal_revoked'
        : org?.paused ? 'organization_paused'
        : !task?.active ? 'task_inactive'
        : !membership.rowCount ? 'task_not_authorized'
        : quote.organizationId !== op.org_id ? 'quote_organization_mismatch'
        : quote.currency !== 'SIM_CENTS' ? 'unsupported_currency'
        : !task.sellers.includes(quote.seller) ? 'seller_not_permitted'
        : new Date(quote.expiresAt) <= membership.rows[0].db_now ? 'quote_expired'
        : total > 500 ? 'purchase_limit'
        : task.requires_assessment ? 'assessment_unavailable'
        : task.reserved_cents + total > 2000 ? 'task_budget_exhausted'
        : task.requires_approval ? 'approval_required' : 'permitted';
      const allowed = reason === 'permitted' || reason === 'approval_required';
      await client.query('INSERT INTO decisions(operation_id,allowed,reason,requires_approval) VALUES ($1,$2,$3,$4)',
        [op.id, allowed, reason, Boolean(task?.requires_approval)]);
      if (reason === 'permitted') {
        await client.query('UPDATE tasks SET reserved_cents=reserved_cents+$1 WHERE id=$2', [total, op.input.taskId]);
        await client.query('INSERT INTO dispatches(operation_id,execution_id,reserved_cents) VALUES ($1,$2,$3)', [op.id, row.id, total]);
        await client.query('INSERT INTO attempts(operation_id,provider_operation_id) VALUES ($1,$2)', [op.id, op.provider_operation_id]);
      }
      return { row, fresh: true };
    });
    if (result.row.input_fingerprint !== claim.inputFingerprint) return { status: 'conflict', executionId: result.row.id };
    if (result.fresh) return { status: 'claimed', executionId: result.row.id };
    return { status: 'existing', outcome: this.awaitOutcome(result.row) };
  }

  private async awaitOutcome(row: ExecutionRow): Promise<StoredExecution> {
    // A dead claimant is never taken over. Bounded waiter rejection is not a terminal Kaji result.
    for (let count = 0; !row.outcome && count < 40; count++) {
      await delay(50);
      row = (await this.pool.query<ExecutionRow>('SELECT * FROM executions WHERE id=$1', [row.id])).rows[0]!;
    }
    if (row.outcome) return row.outcome;
    throw new Error('Execution still unresolved');
  }

  async record(execution: StoredExecution): Promise<void> {
    const op = this.operation;
    const safe: StoredExecution = execution.status === 'succeeded' ? execution
      : { status: execution.status, evidence: execution.evidence, error: { code: `execution_${execution.status}` } };
    await transaction(this.pool, async client => {
      const updated = await client.query(`UPDATE executions SET outcome=$1,recorded_at=now()
        WHERE id=$2 AND operation_id=$3 AND capability=$4 AND principal_id=$5 AND idempotency_key=$6
          AND input_fingerprint=$7 AND outcome IS NULL RETURNING id`,
      [safe, execution.evidence.executionId, op.id, execution.evidence.capability, execution.evidence.principalId,
        execution.evidence.idempotencyKey, execution.evidence.inputFingerprint]);
      if (updated.rowCount !== 1) throw new Error('Execution record mismatch');
      if (safe.status === 'succeeded') {
        const attempt = await client.query(`UPDATE attempts SET state='succeeded',evidence=$1,finished_at=now()
          WHERE operation_id=$2 AND state='unresolved'`, [safe.result, op.id]);
        if (attempt.rowCount !== 1) throw new Error('Missing dispatch');
      }
    });
  }
}

export function createGovernance(pool: Pool, providerUrl: string, providerToken: string) {
  async function provider(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, providerUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${providerToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2500), redirect: 'error',
    });
    if (body === undefined && response.status === 404) throw new HttpError(404, 'Quote not found');
    if (!response.ok) throw new Error('Provider request unresolved');
    // Provider is trusted infrastructure; still validate the response before recording evidence.
    return response.json() as Promise<unknown>;
  }
  async function authenticate(authorization: string | undefined): Promise<Principal> {
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization ?? '');
    if (!match) throw new HttpError(401, 'Authentication required');
    const principal = (await pool.query<Principal>('SELECT id,org_id,role FROM principals WHERE token_hash=$1 AND active', [tokenHash(match[1]!)])).rows[0];
    if (!principal) throw new HttpError(401, 'Authentication required');
    const limit = await pool.query<{ count: number }>(`INSERT INTO rate_limits(principal_id,minute,count)
      VALUES ($1,floor(extract(epoch FROM clock_timestamp())/60),1)
      ON CONFLICT (principal_id) DO UPDATE SET
        count=CASE WHEN rate_limits.minute=excluded.minute THEN rate_limits.count+1 ELSE 1 END,
        minute=excluded.minute RETURNING count`, [principal.id]);
    if (limit.rows[0]!.count > 120) throw new HttpError(429, 'Rate limited');
    return principal;
  }
  async function getOperation(key: string, principal: Principal): Promise<Operation | undefined> {
    const op = (await pool.query<Operation>('SELECT * FROM operations WHERE org_id=$1 AND operation_key=$2', [principal.org_id, key])).rows[0];
    if (op && principal.role !== 'owner' && op.principal_id !== principal.id) throw new HttpError(404, 'Operation not found');
    return op;
  }
  async function status(op: Operation) {
    const row = (await pool.query(`SELECT d.allowed,d.reason,d.requires_approval,e.outcome,
      a.state AS attempt_state,a.evidence,a.started_at,x.recorded_at,x.reserved_cents
      FROM operations o LEFT JOIN decisions d ON d.operation_id=o.id
      LEFT JOIN executions e ON e.operation_id=o.id LEFT JOIN attempts a ON a.operation_id=o.id
      LEFT JOIN dispatches x ON x.operation_id=o.id WHERE o.id=$1`, [op.id])).rows[0]!;
    const state = row.attempt_state === 'succeeded' ? 'succeeded'
      : row.attempt_state ? 'unresolved'
      : row.reason === 'approval_required' ? 'blocked_approval'
      : row.reason === 'assessment_unavailable' ? 'blocked_assessment'
      : row.allowed === false ? 'denied' : 'unresolved';
    return { operationId: op.operation_key, state, fingerprint: op.fingerprint, input: op.input,
      decision: row.reason ? { allowed: row.allowed, reason: row.reason } : null,
      dispatch: row.recorded_at ? { recordedAt: row.recorded_at, reservedCents: row.reserved_cents } : null,
      attempt: row.attempt_state ? { state: row.attempt_state, providerOperationId: op.provider_operation_id, startedAt: row.started_at, evidence: row.evidence } : null,
      kaji: row.outcome ?? null };
  }
  async function execute(op: Operation): Promise<void> {
    const saved = canonicalSchema.parse(op.input);
    if (fingerprint(saved) !== op.fingerprint) throw new Error('Saved input integrity failure');
    let decision: Decision | undefined;
    const purchase = capability({
      name: 'payments.purchase', input: canonicalSchema,
      authorize: async ({ principalId }) => {
        decision = (await pool.query<Decision>('SELECT * FROM decisions WHERE operation_id=$1', [op.id])).rows[0];
        return principalId === op.principal_id && decision?.allowed === true;
      },
      approval: () => decision?.requires_approval === true,
      execute: async () => {
        const dispatch = await pool.query('SELECT 1 FROM dispatches WHERE operation_id=$1', [op.id]);
        if (dispatch.rowCount !== 1) throw new Error('Missing authorized dispatch');
        const receipt = receiptSchema.parse(await provider('/charges', {
          operationId: op.provider_operation_id, quoteId: saved.quote.id, quoteFingerprint: fingerprint(saved.quote),
        }));
        if (receipt.operationId !== op.provider_operation_id || receipt.quoteId !== saved.quote.id
          || receipt.quoteFingerprint !== fingerprint(saved.quote) || receipt.seller !== saved.quote.seller
          || receipt.amountCents !== saved.quote.amountCents || receipt.feeCents !== saved.quote.feeCents
          || receipt.totalCents !== saved.quote.amountCents + saved.quote.feeCents || receipt.currency !== saved.quote.currency)
          throw new Error('Provider evidence mismatch');
        return receipt;
      },
    });
    // Static registry, no user-selected modules or raw adapter endpoint. No approval fallback.
    const registry = { 'payments.purchase': purchase } as const;
    await createKaji({ store: new PgExecutionStore(pool, op) }).execute(registry[saved.action], {
      input: saved, principalId: op.principal_id, idempotencyKey: op.provider_operation_id,
    });
  }
  return serve(async (req, res) => {
    const principal = await authenticate(req.headers.authorization);
    const path = req.url ?? '';
    if (req.method === 'POST' && path === '/operations') {
      if (principal.role !== 'agent') throw new HttpError(403, 'Agent permission required');
      const request = requestSchema.parse(await readJson(req));
      let op = await getOperation(request.operationId, principal);
      if (!op) {
        const member = await pool.query(`SELECT 1 FROM task_agents WHERE task_id=$1 AND principal_id=$2 AND org_id=$3`, [request.taskId, principal.id, principal.org_id]);
        if (!member.rowCount) throw new HttpError(404, 'Task not found');
        const quote = quoteSchema.parse(await provider(`/quotes/${request.quoteId}`));
        if (quote.id !== request.quoteId) throw new Error('Provider quote identity mismatch');
        if (quote.organizationId !== principal.org_id) throw new HttpError(404, 'Quote not found');
        const id = randomUUID();
        const input: CanonicalInput = { operationId: id, organizationId: principal.org_id, principalId: principal.id,
          action: request.action, taskId: request.taskId, quote };
        await pool.query(`INSERT INTO operations(id,org_id,principal_id,operation_key,task_id,request,input,fingerprint,provider_operation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (org_id,operation_key) DO NOTHING`,
        [id, principal.org_id, principal.id, request.operationId, request.taskId, request, input, fingerprint(input), randomUUID()]);
        op = await getOperation(request.operationId, principal);
      }
      if (!op) throw new Error('Operation missing');
      if (fingerprint(op.request) !== fingerprint(request)) throw new HttpError(409, 'Operation identity already used with different input');
      // Claim failure/abandoned claimant remains inspectable. Never retry with a new provider key.
      try { await execute(op); } catch { /* durable status below is authoritative */ }
      const view = await status(op);
      json(res, view.state === 'unresolved' ? 202 : 200, view);
      return;
    }
    const operationPath = /^\/operations\/([a-zA-Z0-9_-]{1,80})$/.exec(path);
    if (req.method === 'GET' && operationPath) {
      const op = await getOperation(identifier.parse(operationPath[1]), principal);
      if (!op) throw new HttpError(404, 'Operation not found');
      json(res, 200, await status(op)); return;
    }
    if (req.method === 'POST' && path === '/owner/pause') {
      if (principal.role !== 'owner') throw new HttpError(403, 'Owner permission required');
      const body = z.strictObject({ paused: z.boolean() }).parse(await readJson(req));
      await transaction(pool, async client => {
        await client.query('SELECT 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE', [principal.org_id]);
        const owner = await client.query('SELECT 1 FROM principals WHERE id=$1 AND active', [principal.id]);
        if (!owner.rowCount) throw new HttpError(401, 'Authentication required');
        await client.query('UPDATE organizations SET paused=$1 WHERE id=$2', [body.paused, principal.org_id]);
        await client.query("INSERT INTO controls(org_id,owner_id,kind,value) VALUES ($1,$2,'pause',$3)", [principal.org_id, principal.id, body]);
      });
      json(res, 200, body); return;
    }
    if (req.method === 'POST' && path === '/owner/revoke') {
      if (principal.role !== 'owner') throw new HttpError(403, 'Owner permission required');
      const body = z.strictObject({ principalId: z.uuid() }).parse(await readJson(req));
      await transaction(pool, async client => {
        await client.query('SELECT 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE', [principal.org_id]);
        const owner = await client.query('SELECT 1 FROM principals WHERE id=$1 AND active', [principal.id]);
        if (!owner.rowCount) throw new HttpError(401, 'Authentication required');
        const target = await client.query("UPDATE principals SET active=false WHERE id=$1 AND org_id=$2 AND role='agent' RETURNING id", [body.principalId, principal.org_id]);
        if (!target.rowCount) throw new HttpError(404, 'Agent not found');
        await client.query("INSERT INTO controls(org_id,owner_id,kind,value) VALUES ($1,$2,'revoke',$3)", [principal.org_id, principal.id, body]);
      });
      json(res, 200, { revoked: true }); return;
    }
    throw new HttpError(404, 'Route not found');
  });
}
