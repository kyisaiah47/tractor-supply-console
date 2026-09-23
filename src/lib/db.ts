import { Pool, types, type PoolClient } from "pg";

types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC -> number
types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT (count) -> number
types.setTypeParser(1082, (v) => v); // DATE stays 'YYYY-MM-DD'

const g = globalThis as unknown as { __supplyPool?: Pool };

export const pool =
  g.__supplyPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://supply:supply@localhost:5433/supply",
    max: 10,
  });
if (process.env.NODE_ENV !== "production") g.__supplyPool = pool;

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
