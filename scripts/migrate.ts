// Applies each database schema once with an atomic migration journal and advisory lock.
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { database, transaction } from '../src/db.js';
import { secret } from '../src/config.js';

export async function migrate(pool: Pool, name: 'governance' | 'provider'): Promise<void> {
  const names = name === 'governance' ? [name, 'governance-003'] : [name];
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cankan-migration'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of names) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [migration])).rowCount) continue;
      await client.query(await readFile(resolve('migrations', `${migration}.sql`), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [migration]);
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = database(secret('DATABASE_URL'));
  const provider = database(secret('PROVIDER_DATABASE_URL'));
  try { await migrate(app, 'governance'); await migrate(provider, 'provider'); console.log('Migrations applied'); }
  finally { await app.end(); await provider.end(); }
}
