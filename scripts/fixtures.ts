// Seeds two isolated organizations, agent and owner identities, tasks, and simulated quotes.
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { database } from '../src/db.js';
import { secret } from '../src/config.js';
import { tokenHash } from '../src/shared.js';

export const ids = {
  orgA: '11111111-1111-4111-8111-111111111111', orgB: '22222222-2222-4222-8222-222222222222',
  agentA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', agentA2: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  ownerA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  agentB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', ownerB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  taskA: 'aaaaaaaa-1111-4111-8111-111111111111', taskB: 'bbbbbbbb-2222-4222-8222-222222222222',
} as const;
export type Tokens = Record<'agentA' | 'agentA2' | 'ownerA' | 'agentB' | 'ownerB', string>;
export async function seed(app: Pool, provider: Pool, tokens: Tokens): Promise<void> {
  for (const [org, name] of [[ids.orgA, 'Organization A'], [ids.orgB, 'Organization B']])
    await app.query('INSERT INTO organizations(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [org, name]);
  for (const key of Object.keys(tokens) as (keyof Tokens)[]) {
    const org = key.endsWith('B') ? ids.orgB : ids.orgA;
    await app.query('INSERT INTO principals(id,org_id,role,token_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [ids[key], org, key.startsWith('owner') ? 'owner' : 'agent', tokenHash(tokens[key])]);
  }
  for (const [task, org, agents] of [[ids.taskA, ids.orgA, [ids.agentA, ids.agentA2]], [ids.taskB, ids.orgB, [ids.agentB]]] as const) {
    await app.query("INSERT INTO tasks(id,org_id,sellers) VALUES ($1,$2,ARRAY['stationery']) ON CONFLICT DO NOTHING", [task, org]);
    for (const agent of agents) await app.query('INSERT INTO task_agents(task_id,principal_id,org_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [task, agent, org]);
  }
  for (const [id, org, amount, fee, seller, currency, expiry, behavior] of [
    ['quote-normal', ids.orgA, 500, 0, 'stationery', 'SIM_CENTS', '30 days', 'normal'],
    ['quote-fees', ids.orgA, 450, 50, 'stationery', 'SIM_CENTS', '30 days', 'normal'],
    ['quote-over-limit', ids.orgA, 500, 1, 'stationery', 'SIM_CENTS', '30 days', 'normal'],
    ['quote-seller', ids.orgA, 100, 0, 'unapproved', 'SIM_CENTS', '30 days', 'normal'],
    ['quote-currency', ids.orgA, 100, 0, 'stationery', 'UNSUPPORTED_SIM', '30 days', 'normal'],
    ['quote-expired', ids.orgA, 100, 0, 'stationery', 'SIM_CENTS', '-1 day', 'normal'],
    ['quote-uncertain', ids.orgA, 500, 0, 'stationery', 'SIM_CENTS', '30 days', 'drop_after_commit'],
    ['quote-org-b', ids.orgB, 500, 0, 'stationery', 'SIM_CENTS', '30 days', 'normal'],
  ]) await provider.query(`INSERT INTO provider_quotes(id,org_id,amount_cents,fee_cents,seller,currency,expires_at,behavior)
    VALUES ($1,$2,$3,$4,$5,$6,now()+$7::interval,$8) ON CONFLICT DO NOTHING`, [id, org, amount, fee, seller, currency, expiry, behavior]);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = database(secret('DATABASE_URL')), provider = database(secret('PROVIDER_DATABASE_URL'));
  try {
    await seed(app, provider, { agentA: secret('AGENT_A_TOKEN'), agentA2: secret('AGENT_A2_TOKEN'),
      ownerA: secret('OWNER_A_TOKEN'), agentB: secret('AGENT_B_TOKEN'), ownerB: secret('OWNER_B_TOKEN') });
    console.log('Two organizations seeded; quote-normal costs 500 SIM_CENTS, fees 0');
  } finally { await app.end(); await provider.end(); }
}
