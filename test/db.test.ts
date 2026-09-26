// Verifies idle PostgreSQL disconnects are redacted and do not crash the service process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('idle database disconnect is contained and the pool reconnects', () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a loopback PostgreSQL /cankan_test database');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(url.pathname, '/cankan_test', 'Tests require the dedicated cankan_test admin database');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Tests require loopback PostgreSQL');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { setTimeout as delay } from 'node:timers/promises';
    import { database } from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
    const pool = database(process.env.TEST_DATABASE_URL);
    const killer = database(process.env.TEST_DATABASE_URL);
    try {
      const { rows: [{ pid }] } = await pool.query('SELECT pg_backend_pid() AS pid');
      assert.equal(pool.idleCount, 1);
      const result = await killer.query('SELECT pg_terminate_backend($1) AS terminated', [pid]);
      assert.equal(result.rows[0].terminated, true);
      for (let i = 0; i < 100 && pool.idleCount; i++) await delay(10);
      assert.equal(pool.idleCount, 0, 'The disconnected idle client must be removed');
      assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
    } finally { await Promise.all([pool.end(), killer.end()]); }
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, 'The database child must survive its idle connection closing');
  assert.equal(result.stdout, '');
  assert.ok(result.stderr === 'Idle database connection failed\n', 'Only the fixed, redacted database error may be logged');
});
