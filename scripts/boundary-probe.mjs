// Runs only inside the real agent container; addresses come from a trusted host controller.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { isIP } from 'node:net';
const targets = JSON.parse(process.argv[2] ?? '[]');
assert.ok(targets.length >= 6, 'Controller must supply live private service names and addresses');
assert.notEqual(process.getuid(), 0);
assert.deepEqual(readdirSync('/run/secrets'), ['agent_token']);
const token = readFileSync('/run/secrets/agent_token', 'utf8').trim();
// Authenticated schema rejection proves the permitted API path without consuming task budget.
const response = await fetch('http://api:3000/operations', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: '{}', signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 400);
assert.deepEqual(await response.json(), { error: 'Invalid request' });
for (const { host, port } of targets) {
  assert.ok(['provider', 'db', 'provider-db'].includes(host) || isIP(host));
  assert.ok([3001, 5432].includes(port));
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Unreachable')); });
  }), `Forbidden connection: ${host}:${port}`);
}
for (const path of ['/run/secrets/provider_token', '/run/secrets/provider_lookup_token', '/run/secrets/database_url',
  '/run/secrets/provider_database_url', '/run/secrets/owner_a_token', '/var/run/docker.sock', '/run/docker.sock',
  '/app/src/governance.ts', '/app/dist/src/governance.js']) assert.throws(() => readFileSync(path));
for (const name of ['DATABASE_URL', 'PROVIDER_DATABASE_URL', 'PROVIDER_TOKEN', 'PROVIDER_LOOKUP_TOKEN'])
  assert.equal(process.env[name], undefined);
assert.throws(() => writeFileSync('/tmp/cankan-probe', 'test'), { code: 'EROFS' });
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
console.log(`Agent boundary checks passed for ${targets.length} live private targets; authenticated API positive control passed`);
