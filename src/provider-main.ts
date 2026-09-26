// Starts the private simulated payment provider with its independent ledger database.
import { createProvider } from './provider.js';
import { database } from './db.js';
import { secret } from './config.js';
const pool = database(secret('PROVIDER_DATABASE_URL'));
const server = createProvider(pool, secret('PROVIDER_TOKEN'));
server.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1', () => console.log('Simulated provider listening'));
process.on('SIGTERM', () => server.close(() => { void pool.end(); }));
