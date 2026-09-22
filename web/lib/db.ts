// Postgres access. Server only. Parameterised queries only; never interpolate values.
// Errors are rethrown without parameters so ciphertext or lookup values never reach logs.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl(),
      ssl: env.databaseSsl() ? { rejectUnauthorized: true } : undefined,
      max: 5,
      idleTimeoutMillis: 10_000,
    });
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  }
  return pool;
}

/** Default database handle. Tests replace it with setDb(). */
let current: Queryable | undefined;
export const db = (): Queryable => current ?? getPool();
export function setDb(q: Queryable | undefined): void {
  current = q;
}

export async function query<R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<R[]> {
  try {
    const r = await db().query<R>(text, params as unknown[]);
    return r.rows;
  } catch (e) {
    throw new Error(`db query failed: ${(e as Error).message}`);
  }
}

export async function one<R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<R | null> {
  const rows = await query<R>(text, params);
  return rows[0] ?? null;
}

/** Run fn in a transaction. With an injected test db, fn runs against it directly. */
export async function tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  if (current) return fn(current);
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client as unknown as Queryable);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
