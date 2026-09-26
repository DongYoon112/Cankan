// Starts the trusted governance API with its database and private provider credentials.
import { createGovernance } from './governance.js';
import { database } from './db.js';
import { secret } from './config.js';
const pool = database(secret('DATABASE_URL'));
const server = createGovernance(pool, secret('PROVIDER_URL'), secret('PROVIDER_TOKEN'));
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => console.log('Governance listening'));
process.on('SIGTERM', () => server.close(() => { void pool.end(); }));
