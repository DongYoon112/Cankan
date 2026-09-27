// Demonstrates a lost provider reply becoming application success without changing Kaji history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { secret } from '../src/config.js';
const base = process.env.API_URL ?? 'http://127.0.0.1:3000';
const operationId = `recovery-${randomUUID()}`;
const headers = { authorization: `Bearer ${secret('AGENT_A_TOKEN')}`, 'content-type': 'application/json' };
const submitted = await fetch(`${base}/operations`, { method: 'POST', headers, signal: AbortSignal.timeout(5000),
  body: JSON.stringify({ operationId, action: 'payments.purchase', taskId: 'aaaaaaaa-1111-4111-8111-111111111111', quoteId: 'quote-uncertain' }) });
assert.equal(submitted.status, 202);
const initial = await submitted.json() as { state: string; kaji: { status: string } };
assert.equal(initial.state, 'unresolved'); assert.equal(initial.kaji.status, 'unknown');
console.log(`Submitted ${operationId}: unresolved, Kaji unknown`);
let recovered = false;
for (let i = 0; i < 60; i++) {
  await delay(500);
  const response = await fetch(`${base}/operations/${operationId}`, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const status = await response.json() as { state: string; kaji: { status: string }; reconciliation: { status: string } };
  if (status.state !== 'succeeded') continue;
  assert.equal(status.kaji.status, 'unknown'); assert.equal(status.reconciliation.status, 'resolved');
  console.log(JSON.stringify(status, null, 2)); recovered = true; break;
}
assert.ok(recovered, 'Start the worker, or run a reconciliation pass after the job becomes due');
