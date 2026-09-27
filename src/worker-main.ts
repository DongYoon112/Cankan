// Runs bounded reconciliation passes with a lookup-only provider credential.
import { setTimeout as delay } from 'node:timers/promises';
import { database } from './db.js';
import { secret } from './config.js';
import { reconcileOnce } from './recovery.js';
const pool = database(secret('DATABASE_URL'));
const providerUrl = secret('PROVIDER_URL'), lookupToken = secret('PROVIDER_LOOKUP_TOKEN');
const once = process.argv.includes('--once');
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
try {
  do {
    try {
      const count = await reconcileOnce(pool, providerUrl, lookupToken);
      if (count || once) console.log(`Reconciliation observations saved: ${count}`);
    }
    catch { console.error('Reconciliation pass failed'); if (once) process.exitCode = 1; }
    if (!once && !stopped) await delay(1000);
  } while (!once && !stopped);
} finally { await pool.end(); }
