// Submits one authenticated simulated purchase and prints its governance result.
import { randomUUID } from 'node:crypto';
import { secret } from '../src/config.js';
const base = process.env.API_URL ?? 'http://127.0.0.1:3000';
const operationId = `demo-${randomUUID()}`;
const response = await fetch(`${base}/operations`, {
  method: 'POST', headers: { authorization: `Bearer ${secret('AGENT_A_TOKEN')}`, 'content-type': 'application/json' },
  signal: AbortSignal.timeout(10_000),
  body: JSON.stringify({ operationId, action: 'payments.purchase',
    taskId: 'aaaaaaaa-1111-4111-8111-111111111111', quoteId: 'quote-normal' }),
});
const result = await response.json() as { state?: string } | null;
console.log(response.status, JSON.stringify(result, null, 2));
if (!response.ok || result?.state !== 'succeeded') process.exitCode = 1;
