// Creates PostgreSQL pools and runs short transactions with rollback on failure.
import pg, { type Pool, type PoolClient } from 'pg';
export function database(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 12 });
  pool.on('error', () => console.error('Idle database connection failed'));
  return pool;
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
