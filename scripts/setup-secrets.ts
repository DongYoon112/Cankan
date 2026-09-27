// Creates local simulator credentials and portable secret files without replacing existing values.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';

await mkdir('.secrets', { recursive: true, mode: 0o700 });
await chmod('.secrets', 0o700);
async function put(name: string, value: string): Promise<string> {
  // The private parent blocks host access; readable file mounts work for non-root container UIDs.
  try { await writeFile(`.secrets/${name}`, `${value}\n`, { mode: 0o444, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await chmod(`.secrets/${name}`, 0o444);
  return (await readFile(`.secrets/${name}`, 'utf8')).trim();
}
const appPassword = await put('app-db-password', randomBytes(32).toString('hex'));
const providerPassword = await put('provider-db-password', randomBytes(32).toString('hex'));
await put('database-url', `postgres://governance:${encodeURIComponent(appPassword)}@db:5432/governance`);
await put('provider-database-url', `postgres://provider:${encodeURIComponent(providerPassword)}@provider-db:5432/provider`);
for (const name of ['provider-token', 'provider-lookup-token', 'agent-a-token', 'agent-a2-token', 'agent-b-token', 'owner-a-token', 'owner-b-token'])
  await put(name, randomBytes(32).toString('hex'));
console.log('Local simulator secrets ready in .secrets/ (existing secrets preserved)');
