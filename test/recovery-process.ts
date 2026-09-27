// Test-only IPC barriers drive independent recovery processes without exposing production fault controls.
import { database } from '../src/db.js';
import { claimRecovery, lookupOutcome, saveObservation, reconcileOnce, type RecoveryClaim } from '../src/recovery.js';
const pool = database(process.env.DATABASE_URL!);
process.on('message', async (message: { id: number; command: string; claim: RecoveryClaim; observation: Parameters<typeof saveObservation>[2] }) => {
  try {
    const result = message.command === 'claim' ? await claimRecovery(pool)
      : message.command === 'lookup' ? await lookupOutcome(message.claim, process.env.PROVIDER_URL!, process.env.PROVIDER_LOOKUP_TOKEN!)
      : message.command === 'save' ? await saveObservation(pool, message.claim, message.observation)
      : await reconcileOnce(pool, process.env.PROVIDER_URL!, process.env.PROVIDER_LOOKUP_TOKEN!);
    process.send?.({ id: message.id, result: result ?? null });
  } catch { process.send?.({ id: message.id, error: 'Worker test command failed' }); }
});
process.on('SIGTERM', () => { void pool.end().then(() => process.disconnect()); });
process.send?.({ ready: true });
