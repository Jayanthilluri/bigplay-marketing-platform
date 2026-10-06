import pg from 'pg';
import { DatabaseError } from '../errors.js';
import { redact } from '../logger.js';

// pg already returns NUMERIC and BIGINT as exact strings. Keep DATE as the
// literal 'YYYY-MM-DD' too, instead of a JS Date shifted by the local zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Opens a single dedicated connection. One connection (rather than a pool)
 * keeps the session-level advisory lock and transactions on the same backend.
 * Use Supabase's direct connection or the *session* pooler (port 5432); the
 * transaction pooler (6543) cannot hold a session advisory lock.
 */
export async function connect(dbConfig, { applicationName = 'bigplay-google-ads-ingestion' } = {}) {
  const client = new pg.Client({
    connectionString: dbConfig.connectionString,
    ssl: dbConfig.ssl,
    application_name: applicationName,
    connectionTimeoutMillis: 15_000,
  });
  try {
    await client.connect();
    await client.query("SET statement_timeout = '10min'");
    await client.query("SET lock_timeout = '30s'");
  } catch (err) {
    await client.end().catch(() => {});
    throw new DatabaseError(`Could not connect to Supabase Postgres: ${redact(err.message)}`, { cause: err, retryable: true });
  }
  return client;
}

export async function withTransaction(client, fn, { readOnly = false } = {}) {
  await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
