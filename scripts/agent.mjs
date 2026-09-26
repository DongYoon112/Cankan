// Demonstrates an agent purchase and checks the container cannot access privileged services or files.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
const token = readFileSync('/run/secrets/agent_token', 'utf8').trim();
const payload = { operationId: `sandbox-${randomUUID()}`, action: 'payments.purchase',
  taskId: 'aaaaaaaa-1111-4111-8111-111111111111', quoteId: 'quote-normal' };
const response = await fetch('http://api:3000/operations', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 200);
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
assert.equal(result?.state, 'succeeded');
// Run inside the actual isolated agent container, with no host mounts or privileged secrets.
for (const [host, port] of [['provider', 3001], ['provider-db', 5432], ['db', 5432]])
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Unreachable')); });
  }));
for (const path of ['/run/secrets/provider_token', '/run/secrets/database_url', '/run/secrets/owner_a_token', '/var/run/docker.sock', '/app/src/governance.ts'])
  assert.throws(() => readFileSync(path));
assert.equal(process.env.DATABASE_URL, undefined);
assert.equal(process.env.PROVIDER_TOKEN, undefined);
console.log('Agent boundary checks passed');
