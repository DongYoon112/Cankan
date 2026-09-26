// Verifies governance and actual provider effects using real PostgreSQL and separate API processes.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { capability, createKaji } from '@irogane/kaji';
import { database } from '../src/db.js';
import { PgExecutionStore } from '../src/governance.js';
import { createProvider } from '../src/provider.js';
import { canonicalSchema, fingerprint, requestSchema } from '../src/shared.js';
import { migrate } from '../scripts/migrate.js';
import { ids, seed, type Tokens } from '../scripts/fixtures.js';

const tokens: Tokens = {
  agentA: 'a'.repeat(48), agentA2: 'c'.repeat(48), ownerA: 'o'.repeat(48),
  agentB: 'b'.repeat(48), ownerB: 'p'.repeat(48),
};
const providerToken = 'private-provider-test-token';

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function launch(connectionString: string, providerUrl: string): Promise<{ child: ChildProcess; url: string }> {
  const child = fork(fileURLToPath(new URL('./process.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, DATABASE_URL: connectionString, PROVIDER_URL: providerUrl, PROVIDER_TOKEN: providerToken,
      DATABASE_URL_FILE: '', PROVIDER_URL_FILE: '', PROVIDER_TOKEN_FILE: '' },
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Governance child startup timed out: ${stderr}`)), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Governance child exited ${code}: ${stderr}`)); });
      child.once('message', (message: { url?: string }) => {
        clearTimeout(timer);
        if (!message.url) reject(new Error('Missing child URL'));
        else resolve(message.url);
      });
    });
    return { child, url };
  } catch (error) { await stop(child); throw error; }
}

async function api(base: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  // Assertions below check the specific response contract relevant to each boundary.
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test('real PostgreSQL governance and provider boundaries', { timeout: 90_000 }, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a loopback PostgreSQL /cankan_test database');
  const adminUrl = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(adminUrl.pathname, '/cankan_test', 'Tests require the dedicated cankan_test admin database');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname), 'Tests require loopback PostgreSQL');
  const admin = database(adminUrl.href);
  const suffix = randomUUID().replaceAll('-', '');
  const appName = `cankan_it_${suffix}_app`, providerName = `cankan_it_${suffix}_provider`;
  const appUrl = new URL(adminUrl), providerDbUrl = new URL(adminUrl);
  appUrl.pathname = `/${appName}`; providerDbUrl.pathname = `/${providerName}`;
  const app = database(appUrl.href), providerDb = database(providerDbUrl.href);
  const created: string[] = [], children: ChildProcess[] = [];
  let provider: Server | undefined;
  try {
    for (const name of [appName, providerName]) {
      await admin.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    await migrate(app, 'governance');
    await migrate(providerDb, 'provider');
    await seed(app, providerDb, tokens);
    provider = createProvider(providerDb, providerToken);
    await new Promise<void>(resolve => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const providerUrl = `http://127.0.0.1:${address.port}`;
    const first = await launch(appUrl.href, providerUrl); children.push(first.child);
    const second = await launch(appUrl.href, providerUrl); children.push(second.child);
    const services = [first.url, second.url];

    async function task(options: { active?: boolean; approval?: boolean; assessment?: boolean; members?: boolean } = {}) {
      const id = randomUUID();
      await app.query(`INSERT INTO tasks(id,org_id,sellers,active,requires_approval,requires_assessment)
        VALUES ($1,$2,ARRAY['stationery'],$3,$4,$5)`,
      [id, ids.orgA, options.active ?? true, options.approval ?? false, options.assessment ?? false]);
      if (options.members !== false) for (const agent of [ids.agentA, ids.agentA2])
        await app.query('INSERT INTO task_agents(task_id,principal_id,org_id) VALUES ($1,$2,$3)', [id, agent, ids.orgA]);
      return id;
    }
    const purchase = (taskId: string, operationId = randomUUID(), quoteId = 'quote-normal', token = tokens.agentA, base = first.url) =>
      api(base, '/operations', token, { operationId, action: 'payments.purchase', taskId, quoteId });
    const count = async () => Number((await providerDb.query('SELECT count(*) FROM provider_charges')).rows[0].count);
    const reserved = async (id: string) => (await app.query('SELECT reserved_cents FROM tasks WHERE id=$1', [id])).rows[0].reserved_cents;

    await t.test('legitimate purchase records exact provider effects, immutable inputs, and fees', async () => {
      const taskId = await task();
      for (const quote of ['quote-normal', 'quote-fees']) {
        const result = await purchase(taskId, randomUUID(), quote);
        assert.equal(result.status, 200);
        assert.equal(result.body.state, 'succeeded');
        assert.equal(result.body.kaji.status, 'succeeded');
        assert.equal(result.body.attempt.evidence.totalCents, 500);
        assert.equal(result.body.attempt.evidence.currency, 'SIM_CENTS');
        const ledger = (await providerDb.query('SELECT evidence FROM provider_charges WHERE operation_id=$1', [result.body.attempt.providerOperationId])).rows[0];
        assert.deepEqual(result.body.attempt.evidence, ledger.evidence);
        assert.deepEqual(result.body.kaji.result, ledger.evidence);
        assert.equal(result.body.fingerprint, fingerprint(result.body.input));
        assert.equal(result.body.input.principalId, ids.agentA);
        assert.equal(result.body.input.organizationId, ids.orgA);
        assert.equal(result.body.input.quote.feeCents, quote === 'quote-fees' ? 50 : 0);
        for (const credential of [...Object.values(tokens), providerToken, appUrl.href, providerDbUrl.href])
          assert.equal(JSON.stringify(result.body).includes(credential), false);
        await assert.rejects(app.query("UPDATE operations SET input='{}' WHERE operation_key=$1", [result.body.operationId]), /immutable/);
        await assert.rejects(app.query('DELETE FROM operations WHERE operation_key=$1', [result.body.operationId]), /immutable/);
      }
      assert.equal(await reserved(taskId), 1000);
      await assert.rejects(providerDb.query("UPDATE provider_quotes SET amount_cents=1 WHERE id='quote-normal'"), /immutable/);
      await assert.rejects(providerDb.query("DELETE FROM provider_quotes WHERE id='quote-normal'"), /immutable/);
      await assert.rejects(providerDb.query('UPDATE provider_charges SET evidence=\'{}\''), /immutable/);
    });

    await t.test('strict trust boundaries reject injected authority, prices, action, and oversized input', async () => {
      const taskId = await task(), before = await count();
      const body = { operationId: randomUUID(), action: 'payments.purchase', taskId, quoteId: 'quote-normal' };
      for (const extra of [{ organizationId: ids.orgB }, { principalId: ids.ownerA }, { amountCents: 1 }, { description: 'Free' }, { action: 'payments.refund' }])
        assert.equal((await api(first.url, '/operations', tokens.agentA, { ...body, ...extra })).status, 400);
      assert.equal((await api(first.url, '/operations', tokens.agentA, { ...body, description: 'x'.repeat(9000) })).status, 413);
      for (const [contentType, expected] of [['Application/JSON ; charset=utf-8', 400], ['text/plain', 415]] as const) {
        const response = await fetch(`${first.url}/operations`, {
          method: 'POST', headers: { authorization: `Bearer ${tokens.agentA}`, 'content-type': contentType },
          body: JSON.stringify({ ...body, action: 'payments.refund' }), signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, expected);
        await response.arrayBuffer();
      }
      assert.equal((await api(first.url, '/operations', undefined, body)).status, 401);
      assert.equal((await api(first.url, '/operations', tokens.ownerA, body)).status, 403);
      assert.equal(await count(), before);
      assert.equal(await reserved(taskId), 0);
    });

    await t.test('every hard policy denial prevents provider calls and budget reservation', async () => {
      const before = await count();
      for (const [quote, reason] of [['quote-seller', 'seller_not_permitted'], ['quote-currency', 'unsupported_currency'],
        ['quote-expired', 'quote_expired'], ['quote-over-limit', 'purchase_limit']] as const) {
        const taskId = await task(), result = await purchase(taskId, randomUUID(), quote);
        assert.equal(result.body.state, 'denied');
        assert.equal(result.body.decision.reason, reason);
        assert.equal(result.body.kaji.status, 'denied');
        assert.equal(result.body.attempt, null);
        assert.equal(await reserved(taskId), 0);
      }
      const inactive = await purchase(await task({ active: false }));
      assert.equal(inactive.body.decision.reason, 'task_inactive');
      assert.equal(inactive.body.attempt, null);
      assert.equal((await purchase(await task({ members: false }))).status, 404);
      assert.equal((await purchase(ids.taskB)).status, 404);
      assert.equal((await purchase(await task(), randomUUID(), 'quote-org-b')).status, 404);
      const missingTask = await task(), missingKey = randomUUID();
      const missingQuote = await purchase(missingTask, missingKey, 'quote-does-not-exist');
      assert.equal(missingQuote.status, 404);
      assert.equal(missingQuote.body.error, 'Quote not found');
      assert.equal(await reserved(missingTask), 0);
      assert.equal((await app.query('SELECT 1 FROM operations WHERE operation_key=$1', [missingKey])).rowCount, 0);
      assert.equal(await count(), before);
    });

    await t.test('quote expiry is checked after waiting for policy row locks', async () => {
      const taskId = await task(), quoteId = randomUUID(), before = await count();
      const blocker = await app.connect();
      let pending: ReturnType<typeof purchase> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM tasks WHERE id=$1 FOR NO KEY UPDATE', [taskId]);
        const quote = (await providerDb.query(`INSERT INTO provider_quotes
          (id,org_id,seller,amount_cents,fee_cents,currency,expires_at,behavior)
          VALUES ($1,$2,'stationery',500,0,'SIM_CENTS',clock_timestamp()+interval '3 seconds','normal')
          RETURNING expires_at`, [quoteId, ids.orgA])).rows[0];
        pending = purchase(taskId, randomUUID(), quoteId);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const activity = await app.query(`SELECT 1 FROM pg_stat_activity
            WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT % FROM tasks %FOR NO KEY UPDATE'`, [appName]);
          if (activity.rowCount) { waiting = true; break; }
          await delay(10);
        }
        assert.ok(waiting, 'request must block on the task row before quote expiry');
        assert.equal((await app.query('SELECT $1::timestamptz > clock_timestamp() AS unexpired', [quote.expires_at])).rows[0].unexpired, true);
        await app.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)', [quote.expires_at]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
      }
      const result = await pending!;
      assert.equal(result.status, 200);
      assert.equal(result.body.state, 'denied');
      assert.equal(result.body.decision.reason, 'quote_expired');
      assert.equal(result.body.dispatch, null);
      assert.equal(result.body.attempt, null);
      assert.equal(await reserved(taskId), 0);
      assert.equal(await count(), before);
    });

    await t.test('two processes and two agents atomically share the 2000-cent task budget', async () => {
      const taskId = await task(), before = await count();
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        purchase(taskId, randomUUID(), 'quote-normal', i % 2 ? tokens.agentA : tokens.agentA2, services[i % 2]!)));
      for (const result of results) assert.equal(result.status, 200, JSON.stringify(results.map(({ status, body }) => ({ status, state: body.state, decision: body.decision, error: body.error }))));
      assert.equal(results.filter(result => result.body.state === 'succeeded').length, 4);
      assert.equal(results.filter(result => result.body.decision.reason === 'task_budget_exhausted').length, 6);
      assert.equal(await count() - before, 4);
      assert.equal(await reserved(taskId), 2000);
      assert.equal(Number((await app.query('SELECT count(*) FROM dispatches d JOIN operations o ON o.id=d.operation_id WHERE o.task_id=$1', [taskId])).rows[0].count), 4);
      assert.equal(Number((await app.query("SELECT count(DISTINCT principal_id) FROM operations WHERE task_id=$1", [taskId])).rows[0].count), 2);
    });

    await t.test('duplicate operations across processes charge once; changed input is rejected', async () => {
      const taskId = await task(), operationId = randomUUID(), before = await count();
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        purchase(taskId, operationId, 'quote-normal', tokens.agentA, services[i % 2]!)));
      for (const result of results) { assert.equal(result.status, 200); assert.equal(result.body.state, 'succeeded'); }
      assert.equal(new Set(results.map(result => result.body.attempt.evidence.receiptId)).size, 1);
      assert.equal(await count() - before, 1);
      assert.equal(await reserved(taskId), 500);
      assert.equal((await purchase(taskId, operationId, 'quote-fees')).status, 409);
      assert.equal((await purchase(await task(), operationId)).status, 409);
      assert.equal((await purchase(taskId, operationId, 'quote-normal', tokens.agentA2)).status, 404);
      assert.equal(await count() - before, 1);
    });

    await t.test('organizations have separate operation namespaces and status access', async () => {
      const key = randomUUID(), result = await purchase(await task(), key);
      assert.equal(result.body.state, 'succeeded');
      assert.equal((await api(first.url, `/operations/${key}`, tokens.agentB)).status, 404);
      assert.equal((await api(first.url, `/operations/${key}`, tokens.ownerB)).status, 404);
      assert.equal((await api(first.url, `/operations/${key}`, tokens.agentA2)).status, 404);
      assert.equal((await api(first.url, `/operations/${key}`, tokens.ownerA)).status, 200);
      assert.equal((await api(first.url, `/operations/${key}`)).status, 401);
      const other = await purchase(ids.taskB, key, 'quote-org-b', tokens.agentB);
      assert.equal(other.body.state, 'succeeded');
      assert.equal(other.body.input.organizationId, ids.orgB);
      assert.notEqual(other.body.attempt.providerOperationId, result.body.attempt.providerOperationId);
      assert.equal((await api(first.url, `/operations/${key}`, tokens.agentA)).body.input.organizationId, ids.orgA);
      assert.equal((await api(first.url, `/operations/${key}`, tokens.agentB)).body.input.organizationId, ids.orgB);
    });

    await t.test('owner pause and unavailable approval/assessment remain closed', async () => {
      const before = await count();
      assert.equal((await api(first.url, '/owner/pause', tokens.agentA, { paused: true })).status, 403);
      assert.equal((await api(first.url, '/owner/pause', tokens.ownerA, { paused: true, organizationId: ids.orgB })).status, 400);
      assert.equal((await api(first.url, '/owner/pause', tokens.ownerA, { paused: true })).status, 200);
      const pausedTask = await task(), paused = await purchase(pausedTask);
      assert.equal(paused.body.decision.reason, 'organization_paused');
      assert.equal(paused.body.state, 'denied');
      assert.equal(await reserved(pausedTask), 0);
      assert.equal((await app.query('SELECT paused FROM organizations WHERE id=$1', [ids.orgB])).rows[0].paused, false);
      assert.equal((await api(first.url, '/owner/pause', tokens.ownerA, { paused: false })).status, 200);
      for (const [options, state, reason] of [[{ approval: true }, 'blocked_approval', 'approval_required'],
        [{ assessment: true }, 'blocked_assessment', 'assessment_unavailable']] as const) {
        const taskId = await task(options), result = await purchase(taskId);
        assert.equal(result.body.state, state);
        assert.equal(result.body.decision.reason, reason);
        assert.equal(result.body.attempt, null);
        assert.equal(result.body.dispatch, null);
        assert.equal(await reserved(taskId), 0);
      }
      assert.equal(await count(), before);
      assert.equal(Number((await app.query("SELECT count(*) FROM controls WHERE kind='pause'")).rows[0].count), 2);
    });

    await t.test('private provider authenticates, deduplicates durably, and exposes no raw app route', async () => {
      const before = await count(), operationId = randomUUID();
      const quote = (await api(providerUrl, '/quotes/quote-normal', providerToken)).body;
      const body = { operationId, quoteId: quote.id, quoteFingerprint: fingerprint(quote) };
      assert.equal((await api(providerUrl, '/charges', undefined, body)).status, 401);
      assert.equal((await api(providerUrl, '/charges', tokens.agentA, body)).status, 401);
      assert.equal((await api(providerUrl, '/charges', providerToken, { ...body, amountCents: 1 })).status, 400);
      assert.equal((await api(providerUrl, '/charges', providerToken, { ...body, operationId: 'invalid' })).status, 400);
      assert.equal((await api(first.url, '/charges', tokens.agentA, body)).status, 404);
      assert.equal((await api(providerUrl, '/admin/ledger', providerToken)).status, 404);
      const results = await Promise.all(Array.from({ length: 6 }, () => api(providerUrl, '/charges', providerToken, body)));
      assert.equal(results.filter(result => result.status === 201).length, 1);
      assert.equal(results.filter(result => result.status === 200).length, 5);
      for (const result of results) assert.deepEqual(result.body, results[0]!.body);
      assert.equal((await api(providerUrl, '/charges', providerToken, { ...body, quoteId: 'quote-fees' })).status, 409);
      assert.equal((await api(providerUrl, '/charges', providerToken, { ...body, quoteFingerprint: '0'.repeat(64) })).status, 409);
      assert.equal(await count() - before, 1);
      for (const id of ['quote-expired', 'quote-currency']) {
        const deniedQuote = (await api(providerUrl, `/quotes/${id}`, providerToken)).body;
        assert.ok([409, 422].includes((await api(providerUrl, '/charges', providerToken, {
          operationId: randomUUID(), quoteId: id, quoteFingerprint: fingerprint(deniedQuote),
        })).status));
      }
      assert.equal(await count() - before, 1);
    });

    await t.test('unknown provider result retains reservation and never dispatches a new payment', async () => {
      const taskId = await task(), key = randomUUID(), before = await count();
      const result = await purchase(taskId, key, 'quote-uncertain');
      assert.equal(result.status, 202);
      assert.equal(result.body.state, 'unresolved');
      assert.equal(result.body.kaji.status, 'unknown');
      assert.equal(result.body.attempt.state, 'unresolved');
      assert.equal(result.body.attempt.evidence, null);
      assert.equal(await reserved(taskId), 500);
      const ledger = (await providerDb.query('SELECT evidence FROM provider_charges WHERE operation_id=$1', [result.body.attempt.providerOperationId])).rows[0];
      assert.equal(ledger.evidence.totalCents, 500);
      const duplicate = await purchase(taskId, key, 'quote-uncertain', tokens.agentA, second.url);
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.body.state, 'unresolved');
      assert.equal(duplicate.body.attempt.providerOperationId, result.body.attempt.providerOperationId);
      assert.equal(await count() - before, 1);
      assert.equal(await reserved(taskId), 500);
      assert.equal((await api(first.url, `/operations/${key}`, tokens.ownerA)).body.state, 'unresolved');
      assert.equal((await purchase(taskId, key, 'quote-normal')).status, 409);
    });

    await t.test('principal rate limit is shared across governance processes', async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const seeded = (await app.query(`INSERT INTO rate_limits(principal_id,minute,count)
            VALUES ($1,floor(extract(epoch FROM clock_timestamp())/60),120)
            ON CONFLICT (principal_id) DO UPDATE SET minute=excluded.minute,count=excluded.count
            RETURNING minute`, [ids.agentA2])).rows[0];
          const statuses = await Promise.all(services.map(async base =>
            (await api(base, '/operations/no-such-operation', tokens.agentA2)).status));
          const current = (await app.query('SELECT floor(extract(epoch FROM clock_timestamp())/60)::bigint AS minute')).rows[0];
          // A new minute legitimately resets the counter; repeat only that boundary case.
          if (seeded.minute !== current.minute) continue;
          assert.deepEqual(statuses, [429, 429]);
          return;
        }
        assert.fail('Could not check the rate limit within one database-clock minute');
      } finally { await app.query('DELETE FROM rate_limits WHERE principal_id=$1', [ids.agentA2]); }
    });

    await t.test('owner revocation is organization-scoped and disables agent authentication', async () => {
      const before = await count();
      assert.equal((await api(first.url, '/owner/revoke', tokens.agentA, { principalId: ids.agentA2 })).status, 403);
      assert.equal((await api(first.url, '/owner/revoke', tokens.ownerA, { principalId: ids.agentB })).status, 404);
      assert.equal((await api(first.url, '/owner/revoke', tokens.ownerA, { principalId: ids.ownerA })).status, 404);
      assert.equal((await api(first.url, '/owner/revoke', tokens.ownerA, { principalId: ids.agentA2 })).status, 200);
      assert.equal((await purchase(await task(), randomUUID(), 'quote-normal', tokens.agentA2, second.url)).status, 401);
      assert.equal(await count(), before);
      assert.equal(Number((await app.query("SELECT count(*) FROM controls WHERE kind='revoke'")).rows[0].count), 1);
    });

    await t.test('abandoned durable claim stays unresolved with budget held and no claimant takeover', async () => {
      const taskId = await task(), id = randomUUID(), key = randomUUID(), before = await count();
      const request = requestSchema.parse({ operationId: key, action: 'payments.purchase', taskId, quoteId: 'quote-normal' });
      const input = canonicalSchema.parse({ operationId: id, organizationId: ids.orgA, principalId: ids.agentA,
        action: request.action, taskId, quote: (await api(providerUrl, '/quotes/quote-normal', providerToken)).body });
      const op: ConstructorParameters<typeof PgExecutionStore>[1] = {
        id, org_id: ids.orgA, principal_id: ids.agentA, operation_key: key, provider_operation_id: randomUUID(),
        input, request, fingerprint: fingerprint(input),
      };
      await app.query(`INSERT INTO operations(id,org_id,principal_id,operation_key,task_id,request,input,fingerprint,provider_operation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, op.org_id, op.principal_id, key, taskId, request, input, op.fingerprint, op.provider_operation_id]);
      const store = new PgExecutionStore(app, op);
      const interrupted = createKaji({ store: {
        claim: async claim => {
          assert.equal((await store.claim(claim)).status, 'claimed');
          throw new Error('Simulated disappearance immediately after durable claim commit');
        },
        record: async () => assert.fail('An interrupted claimant cannot record an outcome'),
      } });
      await assert.rejects(interrupted.execute(capability({
        name: 'payments.purchase', input: canonicalSchema,
        authorize: () => assert.fail('Interrupted before authorization callback'),
        execute: () => assert.fail('Interrupted before provider call'),
      }), { input, principalId: op.principal_id, idempotencyKey: op.provider_operation_id }));
      const saved = (await app.query('SELECT outcome FROM executions WHERE operation_id=$1', [id])).rows[0];
      assert.equal(saved.outcome, null);
      assert.equal(await reserved(taskId), 500);
      const retry = await purchase(taskId, key, 'quote-normal', tokens.agentA, second.url);
      assert.equal(retry.status, 202);
      assert.equal(retry.body.state, 'unresolved');
      assert.equal(retry.body.kaji, null);
      assert.equal(retry.body.attempt.state, 'unresolved');
      assert.equal(retry.body.attempt.providerOperationId, op.provider_operation_id);
      assert.equal(await reserved(taskId), 500);
      assert.equal(await count(), before);
    });
  } finally {
    await Promise.all(children.map(stop));
    if (provider) {
      await new Promise<void>(resolve => { provider!.close(() => resolve()); provider!.closeAllConnections(); });
    }
    await Promise.all([app.end(), providerDb.end()]);
    for (const name of created.reverse()) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
