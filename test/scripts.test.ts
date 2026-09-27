// Checks demo exit codes and secret bootstrap preservation using isolated subprocesses.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = (name: string) => ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL(`../scripts/${name}.ts`, import.meta.url))];

test('host demo succeeds only for a completed purchase', { timeout: 20_000 }, async () => {
  let state = 'succeeded', status = 200;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ state }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const options = { timeout: 10_000, env: { ...process.env, AGENT_A_TOKEN: 'script-test-token',
      AGENT_A_TOKEN_FILE: '', API_URL: `http://127.0.0.1:${address.port}` } };
    const result = await run(process.execPath, script('demo'), options);
    assert.match(result.stdout, /"state": "succeeded"/);
    for (const sample of [{ state: 'denied', status: 200 }, { state: 'unresolved', status: 202 }]) {
      ({ state, status } = sample);
      await assert.rejects(run(process.execPath, script('demo'), options), { code: 1 });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('container demo rejects a denied purchase before boundary checks', async () => {
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...options) => path === '/run/secrets/agent_token' ? 'script-test-token' : read(path, ...options);
    syncBuiltinESMExports();
    globalThis.fetch = async () => new Response(JSON.stringify({ state: 'denied' }), { status: 200 });
    await import(${JSON.stringify(new URL('../scripts/agent.mjs', import.meta.url).href)});
  `;
  await assert.rejects(run(process.execPath, ['--input-type=module', '--eval', source], { timeout: 10_000 }),
    { code: 1, stderr: /actual: 'denied'/ });
});

test('secret bootstrap escapes preserved passwords and retains existing secrets', { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cankan-secrets-test-'));
  const password = 'test:password@with/path#hash?query%space value';
  try {
    await mkdir(join(cwd, '.secrets'));
    for (const name of ['app-db-password', 'provider-db-password'])
      await writeFile(join(cwd, '.secrets', name), `${password}\n`);
    await writeFile(join(cwd, '.secrets', 'agent-a-token'), 'preserved-test-token\n');
    await run(process.execPath, script('setup-secrets'), { cwd, timeout: 10_000 });
    for (const [name, host] of [['database-url', 'db'], ['provider-database-url', 'provider-db']] as const) {
      const url = new URL((await readFile(join(cwd, '.secrets', name), 'utf8')).trim());
      assert.equal(url.hostname, host);
      assert.equal(decodeURIComponent(url.password), password);
    }
    const names = ['app-db-password', 'provider-db-password', 'database-url', 'provider-database-url',
      'provider-token', 'provider-lookup-token', 'agent-a-token', 'agent-a2-token', 'agent-b-token', 'owner-a-token', 'owner-b-token'];
    const readSecrets = () => Promise.all(names.map(name => readFile(join(cwd, '.secrets', name), 'utf8')));
    const original = await readSecrets();
    assert.equal(original[names.indexOf('agent-a-token')], 'preserved-test-token\n');
    await run(process.execPath, script('setup-secrets'), { cwd, timeout: 10_000 });
    assert.deepEqual(await readSecrets(), original);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
