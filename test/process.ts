// Runs an independent governance process for cross-process integration tests.
import { createGovernance } from '../src/governance.js';
import { database } from '../src/db.js';
import { secret } from '../src/config.js';

const pool = database(secret('DATABASE_URL'));
const server = createGovernance(pool, secret('PROVIDER_URL'), secret('PROVIDER_TOKEN'));
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  process.send?.({ url: `http://127.0.0.1:${address.port}` });
});
process.on('SIGTERM', () => {
  server.close(() => { void pool.end().then(() => process.disconnect()); });
  server.closeAllConnections();
});
