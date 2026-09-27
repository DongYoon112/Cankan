// Exercises durable recovery, fencing, late results, and control races against real PostgreSQL.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { capability, createKaji, type StoredExecution } from '@irogane/kaji';
import { database } from '../src/db.js';
import { PgExecutionStore } from '../src/governance.js';
import { createProvider } from '../src/provider.js';
import { fingerprint, canonicalSchema } from '../src/shared.js';
import { claimRecovery, lookupOutcome, saveObservation } from '../src/recovery.js';
import { migrate } from '../scripts/migrate.js';
import { seed, ids, type Tokens } from '../scripts/fixtures.js';

const tokens: Tokens = { agentA: 'a'.repeat(48), agentA2: 'c'.repeat(48), agentB: 'b'.repeat(48), ownerA: 'o'.repeat(48), ownerB: 'p'.repeat(48) };
const paymentToken = 'stage3-payment-token', lookupToken = 'stage3-lookup-token';
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
async function http(base: string, path: string, token: string, body?: unknown) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test('stage 3 reconciliation and deterministic control races', { timeout: 120000 }, async t => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const adminUrl = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(adminUrl.pathname, '/cankan_test');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname));
  const admin = database(adminUrl.href), suffix = randomUUID().replaceAll('-', '');
  const appName = `cankan_recovery_${suffix}_app`, providerName = `cankan_recovery_${suffix}_provider`;
  const appUrl = new URL(adminUrl), providerDbUrl = new URL(adminUrl);
  appUrl.pathname = '/' + appName; providerDbUrl.pathname = '/' + providerName;
  const app = database(appUrl.href), providerDb = database(providerDbUrl.href);
  const children: ChildProcess[] = [], servers: Server[] = [], created: string[] = [];
  let submissions = 0, lookups = 0;
  try {
    for (const name of [appName, providerName]) { await admin.query(`CREATE DATABASE "${name}"`); created.push(name); }
    // Start with the exact old schemas, then exercise the upgrade path with existing durable work.
    await app.query(await readFile('migrations/governance.sql', 'utf8'));
    await app.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now()); INSERT INTO schema_migrations(name) VALUES ('governance')");
    await migrate(providerDb, 'provider'); await seed(app, providerDb, tokens);
    const provider = createProvider(providerDb, paymentToken, lookupToken); servers.push(provider);
    provider.on('request', req => { if (req.method === 'POST' && req.url === '/charges') submissions++;
      if (req.url?.startsWith('/organizations/')) lookups++; });
    const providerUrl = await listen(provider);
    const legacyId = randomUUID(), legacyProvider = randomUUID();
    const legacyQuote = (await http(providerUrl, '/quotes/quote-normal', paymentToken)).body;
    const legacyInput = { operationId: legacyId, organizationId: ids.orgA, principalId: ids.agentA,
      action: 'payments.purchase', taskId: ids.taskA, quote: legacyQuote };
    await app.query(`INSERT INTO operations(id,org_id,principal_id,operation_key,task_id,request,input,fingerprint,provider_operation_id)
      VALUES($1,$2,$3,'legacy',$4,$5,$6,$7,$8)`, [legacyId, ids.orgA, ids.agentA, ids.taskA,
      { operationId: 'legacy', action: 'payments.purchase', taskId: ids.taskA, quoteId: 'quote-normal' }, legacyInput, fingerprint(legacyInput), legacyProvider]);
    const legacyExecution = randomUUID();
    await app.query(`INSERT INTO executions(id,operation_id,capability,principal_id,idempotency_key,input_fingerprint)
      VALUES($1,$2,'payments.purchase',$3,$4,'legacy')`, [legacyExecution, legacyId, ids.agentA, legacyProvider]);
    await app.query('INSERT INTO dispatches(operation_id,execution_id,reserved_cents) VALUES($1,$2,500)', [legacyId, legacyExecution]);
    await app.query('INSERT INTO attempts(operation_id,provider_operation_id) VALUES($1,$2)', [legacyId, legacyProvider]);
    await app.query('UPDATE tasks SET reserved_cents=500 WHERE id=$1', [ids.taskA]);
    await t.test('migration backfills old attempts, preserves reservations, and is repeatable', async () => {
      await migrate(app, 'governance'); await migrate(app, 'governance');
      assert.equal((await app.query('SELECT state FROM reconciliation_jobs WHERE operation_id=$1', [legacyId])).rows[0].state, 'pending');
      assert.equal((await app.query('SELECT reserved_cents FROM tasks WHERE id=$1', [ids.taskA])).rows[0].reserved_cents, 500);
    });
    async function launch(script: string) {
      const child = fork(fileURLToPath(new URL(script, import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore','ignore','pipe','ipc'],
        env: { ...process.env, DATABASE_URL: appUrl.href, DATABASE_URL_FILE: '', PROVIDER_URL: providerUrl, PROVIDER_URL_FILE: '',
          PROVIDER_TOKEN: script === './process.ts' ? paymentToken : '', PROVIDER_TOKEN_FILE: '',
          PROVIDER_LOOKUP_TOKEN: lookupToken, PROVIDER_LOOKUP_TOKEN_FILE: '' },
      });
      children.push(child);
      const ready = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child startup timed out')), 10000);
        child.once('message', message => { clearTimeout(timer); resolve(message); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}`)); });
      });
      return { child, ready };
    }
    const api = (await launch('./process.ts')).ready.url as string;
    const worker1 = (await launch('./recovery-process.ts')).child, worker2 = (await launch('./recovery-process.ts')).child;
    let messageId = 0;
    async function command(child: ChildProcess, command: string, rest: Record<string, unknown> = {}) {
      const id = ++messageId;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Worker timed out')); }, 10000);
        const receive = (message: any) => {
          if (message.id !== id) return;
          clearTimeout(timer); child.off('message', receive);
          if (message.error) reject(new Error(message.error)); else resolve(message.result);
        };
        child.on('message', receive); child.send({ id, command, ...rest });
      });
    }
    async function task() {
      const id = randomUUID();
      await app.query("INSERT INTO tasks(id,org_id,sellers) VALUES($1,$2,ARRAY['stationery'])", [id, ids.orgA]);
      await app.query('INSERT INTO task_agents(task_id,principal_id,org_id) VALUES($1,$2,$3)', [id, ids.agentA, ids.orgA]);
      return id;
    }
    async function purchase(quoteId = 'quote-uncertain') {
      const taskId = await task(), key = randomUUID();
      const result = await http(api, '/operations', tokens.agentA, { operationId: key, action: 'payments.purchase', taskId, quoteId });
      return { ...result, key, taskId, id: result.body.input?.operationId as string };
    }
    const view = (key: string, token = tokens.ownerA) => http(api, `/operations/${key}`, token);
    async function due(id: string) {
      await app.query("UPDATE reconciliation_jobs SET next_check_at=clock_timestamp()+interval '1 day' WHERE state='pending'");
      await app.query("UPDATE reconciliation_jobs SET next_check_at=clock_timestamp() WHERE operation_id=$1 AND state='pending'", [id]);
    }
    const budget = async (id: string) => (await app.query('SELECT reserved_cents FROM tasks WHERE id=$1', [id])).rows[0].reserved_cents;
    const history = async (id: string) => (await app.query('SELECT * FROM reconciliation_observations WHERE operation_id=$1 ORDER BY id', [id])).rows;
    async function interrupted() {
      const taskId = await task(), id = randomUUID(), key = randomUUID();
      const input = canonicalSchema.parse({ ...legacyInput, operationId: id, taskId });
      const op: ConstructorParameters<typeof PgExecutionStore>[1] = { id, org_id: ids.orgA, principal_id: ids.agentA,
        operation_key: key, provider_operation_id: randomUUID(), input, fingerprint: fingerprint(input),
        request: { operationId: key, action: 'payments.purchase', taskId, quoteId: 'quote-normal' } };
      await app.query(`INSERT INTO operations(id,org_id,principal_id,operation_key,task_id,request,input,fingerprint,provider_operation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, ids.orgA, ids.agentA, key, taskId, op.request, input, op.fingerprint, op.provider_operation_id]);
      const store = new PgExecutionStore(app, op);
      await assert.rejects(createKaji({ store: { claim: async claim => { await store.claim(claim); throw new Error('Interrupted'); },
        record: async () => assert.fail('No result after interruption') } }).execute(capability({ name: 'payments.purchase', input: canonicalSchema,
        authorize: () => true, execute: () => assert.fail('No payment after interruption') }),
      { input, principalId: ids.agentA, idempotencyKey: op.provider_operation_id }));
      const execution = (await app.query('SELECT * FROM executions WHERE operation_id=$1', [id])).rows[0];
      const evidence = { executionId: execution.id, capability: execution.capability, principalId: execution.principal_id,
        idempotencyKey: execution.idempotency_key, inputFingerprint: execution.input_fingerprint };
      return { op, store, evidence, taskId, key, id };
    }
    async function originalCharge(op: ConstructorParameters<typeof PgExecutionStore>[1]) {
      return (await http(providerUrl, '/charges', paymentToken, { operationId: op.provider_operation_id,
        quoteId: op.input.quote.id, quoteFingerprint: fingerprint(op.input.quote) })).body;
    }

    await t.test('lookup requires a separate credential and exact organization; it cannot charge', async () => {
      const result = await purchase(), path = `/organizations/${ids.orgA}/operations/${result.body.attempt.providerOperationId}`;
      assert.equal((await http(providerUrl, path, lookupToken)).status, 200);
      assert.equal((await http(providerUrl, path, paymentToken)).status, 403);
      assert.equal((await http(providerUrl, path, tokens.agentA)).status, 401);
      assert.equal((await http(providerUrl, path.replace(ids.orgA, ids.orgB), lookupToken)).status, 404);
      const count = Number((await providerDb.query('SELECT count(*) FROM provider_charges')).rows[0].count);
      assert.equal((await http(providerUrl, '/charges', lookupToken, {})).status, 403);
      assert.equal(Number((await providerDb.query('SELECT count(*) FROM provider_charges')).rows[0].count), count);
    });
    await t.test('two worker processes recover lost responses once without resubmission or budget changes', async () => {
      const result = await purchase(); assert.equal(result.body.kaji.status, 'unknown');
      const before = submissions, beforeLookups = lookups;
      await due(result.id);
      await Promise.all([command(worker1, 'once'), command(worker2, 'once')]);
      const recovered = (await view(result.key)).body;
      assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.kaji.status, 'unknown');
      assert.equal(recovered.reconciliation.status, 'resolved'); assert.equal(recovered.reconciliation.lookupCount, 1);
      assert.ok(recovered.reconciliation.lastCheck); assert.equal(recovered.reconciliation.nextCheck, null);
      assert.deepEqual(recovered.attempt.evidence, (await providerDb.query('SELECT evidence FROM provider_charges WHERE operation_id=$1', [result.body.attempt.providerOperationId])).rows[0].evidence);
      assert.equal(await budget(result.taskId), 500); assert.equal(submissions, before); assert.equal(lookups, beforeLookups + 1);
      assert.equal((await history(result.id)).length, 1);
      for (const token of [tokens.agentB, tokens.ownerB, tokens.agentA2]) assert.equal((await view(result.key, token)).status, 404);
      assert.equal((await view(result.key, tokens.agentA)).status, 200);
    });
    await t.test('404 after interrupted dispatch remains unresolved, backs off, then accepts delayed original charge', async () => {
      const result = await interrupted(), before = submissions; await due(result.id);
      await command(worker1, 'once');
      let current = (await view(result.key)).body;
      assert.equal(current.state, 'unresolved'); assert.equal(current.kaji, null);
      assert.equal(current.reconciliation.lastError, 'not_found'); assert.ok(new Date(current.reconciliation.nextCheck) > new Date(current.reconciliation.lastCheck));
      assert.equal(await budget(result.taskId), 500); assert.equal(submissions, before);
      await originalCharge(result.op); await due(result.id); await command(worker2, 'once');
      current = (await view(result.key)).body;
      assert.equal(current.state, 'succeeded'); assert.equal(current.kaji, null); assert.equal(submissions, before + 1);
      assert.equal(await budget(result.taskId), 500);
    });
    await t.test('expired leases fence success and error writes even without a successor; new generation wins', async () => {
      const result = await purchase(); await due(result.id);
      const old = await command(worker1, 'claim'), observation = await command(worker1, 'lookup', { claim: old });
      await app.query("UPDATE reconciliation_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [result.id]);
      assert.equal(await command(worker1, 'save', { claim: old, observation }), false);
      assert.equal(await command(worker1, 'save', { claim: old, observation: { code: 'lookup_unavailable' } }), false);
      assert.equal((await history(result.id)).length, 0);
      const successor = await command(worker2, 'claim'); assert.equal(successor.generation, old.generation + 1);
      assert.equal(await command(worker1, 'save', { claim: old, observation }), false);
      assert.equal(await command(worker2, 'save', { claim: successor, observation }), true);
      assert.equal(await command(worker1, 'save', { claim: old, observation: { code: 'not_found' } }), false);
      assert.equal((await view(result.key)).body.state, 'succeeded'); assert.equal((await history(result.id)).length, 1);
    });
    await t.test('killed worker leaves durable work recoverable by another process', async () => {
      const result = await purchase(); await due(result.id);
      const doomed = (await launch('./recovery-process.ts')).child;
      await command(doomed, 'claim'); await new Promise<void>(resolve => { doomed.once('exit', () => resolve()); doomed.kill('SIGKILL'); });
      await app.query("UPDATE reconciliation_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [result.id]);
      await command(worker2, 'once');
      assert.equal((await view(result.key)).body.state, 'succeeded'); assert.equal(await budget(result.taskId), 500);
    });
    await t.test('API killed after provider commit retains its job and reconciles without inventing Kaji history', async () => {
      await app.query(`CREATE FUNCTION test_record_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(773303); RETURN NEW; END $$;
        CREATE TRIGGER test_record_barrier BEFORE UPDATE OF outcome ON executions
        FOR EACH ROW EXECUTE FUNCTION test_record_barrier()`);
      const barrier = await app.connect(); await barrier.query('SELECT pg_advisory_lock(773303)');
      const doomed = await launch('./process.ts'), taskId = await task(), key = randomUUID(), before = submissions;
      const request = http(doomed.ready.url, '/operations', tokens.agentA, {
        operationId: key, action: 'payments.purchase', taskId, quoteId: 'quote-normal',
      }).catch(() => null);
      try {
        await blocked(appName, 'UPDATE executions SET outcome');
        await new Promise<void>(resolve => { doomed.child.once('exit', () => resolve()); doomed.child.kill('SIGKILL'); });
      } finally {
        await barrier.query('SELECT pg_advisory_unlock(773303)'); barrier.release();
        await app.query('DROP TRIGGER test_record_barrier ON executions');
      }
      await request;
      const initial = (await view(key)).body;
      assert.equal(initial.state, 'unresolved'); assert.equal(initial.kaji, null);
      await due(initial.input.operationId); await command(worker2, 'once');
      const recovered = (await view(key)).body;
      assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.kaji, null);
      assert.equal(submissions, before + 1); assert.equal(await budget(taskId), 500);
      assert.deepEqual(recovered.attempt.evidence, (await providerDb.query('SELECT evidence FROM provider_charges WHERE operation_id=$1', [initial.attempt.providerOperationId])).rows[0].evidence);
    });
    await t.test('lease is rechecked after a blocked save; changed attempt versions also fence writes', async () => {
      const result = await purchase(); await due(result.id);
      const claim = await command(worker1, 'claim'), observation = await command(worker1, 'lookup', { claim });
      const barrier = await app.connect();
      await barrier.query('BEGIN');
      await barrier.query('SELECT 1 FROM attempts WHERE operation_id=$1 FOR UPDATE', [result.id]);
      const saving = command(worker1, 'save', { claim, observation });
      try {
        await blocked(appName, 'SELECT state,evidence,version FROM attempts');
        await barrier.query("UPDATE reconciliation_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [result.id]);
        await barrier.query('COMMIT');
      } finally { await barrier.query('ROLLBACK'); barrier.release(); }
      assert.equal(await saving, false);
      const successor = await command(worker2, 'claim');
      await app.query('UPDATE attempts SET version=version+1 WHERE operation_id=$1', [result.id]);
      assert.equal(await command(worker2, 'save', { claim: successor, observation }), false);
      assert.equal((await history(result.id)).length, 0); assert.equal(await budget(result.taskId), 500);
      await app.query("UPDATE reconciliation_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [result.id]);
      await command(worker1, 'once'); assert.equal((await view(result.key)).body.state, 'succeeded');
    });
    await t.test('observation failure rolls back receipt, application version, and job resolution together', async () => {
      const result = await purchase(); await due(result.id);
      const claim = (await claimRecovery(app))!, observation = await lookupOutcome(claim, providerUrl, lookupToken);
      await app.query(`CREATE FUNCTION test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'test audit failure'; END $$;
        CREATE TRIGGER test_audit_failure BEFORE INSERT ON reconciliation_observations
        FOR EACH ROW EXECUTE FUNCTION test_audit_failure()`);
      try { await assert.rejects(saveObservation(app, claim, observation)); }
      finally { await app.query('DROP TRIGGER test_audit_failure ON reconciliation_observations'); }
      const current = (await view(result.key)).body;
      assert.equal(current.state, 'unresolved'); assert.equal(current.attempt.evidence, null);
      assert.equal(current.reconciliation.status, 'leased'); assert.equal((await history(result.id)).length, 0);
      assert.equal((await app.query('SELECT version FROM attempts WHERE operation_id=$1', [result.id])).rows[0].version, 0);
      assert.equal(await saveObservation(app, claim, observation), true); assert.equal(await budget(result.taskId), 500);
    });
    await t.test('exhausted crashed leases require attention and cannot create a ninth lookup', async () => {
      const result = await interrupted(); await due(result.id);
      await app.query('UPDATE reconciliation_jobs SET lookup_count=7 WHERE operation_id=$1', [result.id]);
      const finalClaim = await command(worker1, 'claim'), before = lookups;
      await app.query("UPDATE reconciliation_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [result.id]);
      assert.equal(await command(worker2, 'claim'), null);
      assert.equal(await command(worker1, 'save', { claim: finalClaim, observation: { code: 'not_found' } }), false);
      assert.equal(lookups, before); assert.equal((await view(result.key)).body.reconciliation.status, 'attention');
      assert.equal(await budget(result.taskId), 500);
    });
    await t.test('malformed, mismatched, unavailable evidence and retry exhaustion never release budget', async () => {
      const result = await purchase();
      const real = (await http(providerUrl, `/organizations/${ids.orgA}/operations/${result.body.attempt.providerOperationId}`, lookupToken)).body;
      let payload: unknown = {}, responseStatus = 200, hang = false;
      const faulty = createServer((_req, res) => { if (hang) return; res.writeHead(responseStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); });
      servers.push(faulty); const faultUrl = await listen(faulty);
      const cases = [
        { code: 'malformed_evidence', value: {} },
        { code: 'mismatched_evidence', value: { ...real, organizationId: ids.orgB } },
        ...['operationId','quoteId','quoteFingerprint','seller','amountCents','feeCents','totalCents','currency'].map(field => ({
          code: field === 'currency' ? 'malformed_evidence' : 'mismatched_evidence',
          value: { ...real, receipt: { ...real.receipt, [field]: field === 'operationId' ? randomUUID()
            : field === 'quoteFingerprint' ? '0'.repeat(64) : typeof real.receipt[field] === 'number' ? real.receipt[field] + 1 : 'wrong' } },
        })),
        { code: 'mismatched_evidence', value: { ...real, quote: { ...real.quote, organizationId: ids.orgB } } },
      ];
      await due(result.id); const claim = (await claimRecovery(app))!;
      for (const sample of cases) { payload = sample.value; assert.equal((await lookupOutcome(claim, faultUrl, lookupToken)).code, sample.code); }
      payload = 'x'.repeat(8193); assert.equal((await lookupOutcome(claim, faultUrl, lookupToken)).code, 'malformed_evidence');
      hang = true; assert.equal((await lookupOutcome(claim, faultUrl, lookupToken)).code, 'lookup_unavailable'); hang = false;
      responseStatus = 503; assert.equal((await lookupOutcome(claim, faultUrl, lookupToken)).code, 'lookup_unavailable');
      responseStatus = 404; assert.equal((await lookupOutcome(claim, faultUrl, lookupToken)).code, 'not_found');
      responseStatus = 200; payload = cases[1]!.value;
      assert.equal(await saveObservation(app, claim, await lookupOutcome(claim, faultUrl, lookupToken)), true);
      assert.equal((await history(result.id))[0].code, 'mismatched_evidence');
      assert.equal((await view(result.key)).body.state, 'unresolved');
      const before = submissions;
      for (let i = 1; i < 8; i++) { await due(result.id); const retry = (await claimRecovery(app))!;
        await saveObservation(app, retry, { code: 'lookup_unavailable' }); }
      const final = (await view(result.key)).body;
      assert.equal(final.state, 'unresolved'); assert.equal(final.reconciliation.status, 'attention');
      assert.equal(final.reconciliation.lookupCount, 8); assert.equal(final.reconciliation.nextCheck, null);
      assert.equal(await budget(result.taskId), 500); assert.equal(submissions, before);
      assert.ok(!JSON.stringify(final).includes(lookupToken)); assert.ok(!JSON.stringify(final).includes('diagnostic'));
    });
    await t.test('late original success/unknown preserves recovery; identical results replay, contradictions are audited', async () => {
      for (const originalStatus of ['succeeded','unknown'] as const) {
        const result = await interrupted(), receipt = await originalCharge(result.op); await due(result.id); await command(worker1, 'once');
        const outcome: StoredExecution = originalStatus === 'succeeded' ? { status: 'succeeded', evidence: result.evidence, result: receipt }
          : { status: 'unknown', evidence: result.evidence, error: { code: 'timeout' } };
        await result.store.record(outcome); await result.store.record(outcome);
        const current = (await view(result.key)).body;
        assert.equal(current.state, 'succeeded'); assert.equal(current.kaji.status, originalStatus); assert.equal(await budget(result.taskId), 500);
      }
      const conflict = await interrupted(), receipt = await originalCharge(conflict.op); await due(conflict.id); await command(worker2, 'once');
      await assert.rejects(conflict.store.record({ status: 'succeeded', evidence: conflict.evidence, result: { ...receipt, receiptId: randomUUID() } }));
      assert.deepEqual((await view(conflict.key)).body.attempt.evidence, receipt);
      assert.equal((await history(conflict.id)).at(-1).code, 'contradictory_receipt');
      assert.equal(await budget(conflict.taskId), 500);
    });
    await t.test('original completion first fences an in-flight lookup and stores success once', async () => {
      const result = await interrupted(), receipt = await originalCharge(result.op); await due(result.id);
      const claim = await command(worker1, 'claim'), observation = await command(worker1, 'lookup', { claim });
      await result.store.record({ status: 'succeeded', evidence: result.evidence, result: receipt });
      assert.equal(await command(worker1, 'save', { claim, observation }), false);
      assert.equal((await view(result.key)).body.kaji.status, 'succeeded'); assert.equal((await history(result.id)).length, 1);
      assert.equal(await budget(result.taskId), 500);
    });

    // These barriers exist only in these uniquely named test databases, never in simulator fixtures.
    await app.query(`CREATE FUNCTION test_control_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(773301); RETURN NEW; END $$;
      CREATE TRIGGER test_control_barrier BEFORE INSERT ON controls FOR EACH ROW EXECUTE FUNCTION test_control_barrier()`);
    await providerDb.query(`CREATE FUNCTION test_charge_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(773302); RETURN NEW; END $$;
      CREATE TRIGGER test_charge_barrier BEFORE INSERT ON provider_charges FOR EACH ROW EXECUTE FUNCTION test_charge_barrier()`);
    async function blocked(databaseName: string, queryFragment: string) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const found = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND query LIKE $2
          AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`, [databaseName, '%' + queryFragment + '%']);
        if (found.rowCount) return;
        await delay(5); // Polls an observed database barrier, never chooses the commit ordering by elapsed time.
      }
      assert.fail('Database barrier not reached: ' + queryFragment);
    }
    for (const kind of ['pause','revoke'] as const) for (const first of ['control','dispatch'] as const) {
      await t.test(`${kind} race: ${first} commits first; recovery ignores subsequent controls`, async () => {
        await app.query('UPDATE organizations SET paused=false WHERE id=$1', [ids.orgA]);
        await app.query('UPDATE principals SET active=true WHERE id=$1', [ids.agentA]);
        const taskId = await task(), key = randomUUID(), before = submissions;
        const control = () => http(api, `/owner/${kind}`, tokens.ownerA, kind === 'pause' ? { paused: true } : { principalId: ids.agentA });
        const dispatch = () => http(api, '/operations', tokens.agentA, { operationId: key, action: 'payments.purchase', taskId, quoteId: 'quote-uncertain' });
        const barrier = await (first === 'control' ? app : providerDb).connect();
        const lock = first === 'control' ? 773301 : 773302;
        await barrier.query('SELECT pg_advisory_lock($1)', [lock]);
        let operation: ReturnType<typeof dispatch> | undefined, controlResult: ReturnType<typeof control> | undefined;
        try {
          if (first === 'control') {
            controlResult = control(); await blocked(appName, 'INSERT INTO controls');
            operation = dispatch(); await blocked(appName, 'SELECT paused FROM organizations');
          } else {
            operation = dispatch(); await blocked(providerName, 'INSERT INTO provider_charges');
            assert.equal((await control()).status, 200);
          }
        } finally { await barrier.query('SELECT pg_advisory_unlock($1)', [lock]); barrier.release(); }
        if (controlResult) assert.equal((await controlResult).status, 200);
        assert.ok(operation); const result = await operation;
        if (first === 'control') {
          assert.equal(result.body.state, 'denied'); assert.equal(result.body.dispatch, null);
          assert.equal(submissions, before); assert.equal(await budget(taskId), 0);
        } else {
          assert.equal(result.body.state, 'unresolved'); assert.equal(submissions, before + 1);
          await due(result.body.input.operationId); await command(worker2, 'once');
          assert.equal((await view(key)).body.state, 'succeeded'); assert.equal(await budget(taskId), 500);
          assert.equal(submissions, before + 1);
        }
        const subsequent = await dispatch();
        assert.equal(kind === 'revoke' ? subsequent.status : subsequent.body.state, kind === 'revoke' ? 401 : first === 'control' ? 'denied' : 'succeeded');
        const next = await http(api, '/operations', tokens.agentA, { operationId: randomUUID(), action: 'payments.purchase', taskId, quoteId: 'quote-normal' });
        assert.equal(kind === 'revoke' ? next.status : next.body.state, kind === 'revoke' ? 401 : 'denied');
        assert.equal(submissions, before + (first === 'dispatch' ? 1 : 0));
      });
    }
  } finally {
    await Promise.all(children.map(stop)); await Promise.all(servers.map(close));
    await Promise.all([app.end(), providerDb.end()]);
    for (const name of created.reverse()) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
