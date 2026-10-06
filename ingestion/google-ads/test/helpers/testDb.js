// Creates a throwaway local database loaded with the replica of the live
// Supabase schema (test/fixtures/live-schema.sql). Refuses to run against any
// non-local host so it can never touch production.

import fs from 'node:fs';
import pg from 'pg';

const FIXTURE = new URL('../fixtures/live-schema.sql', import.meta.url);

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function createTestDatabase(name) {
  const url = new URL(TEST_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1', ''].includes(url.hostname)) {
    throw new Error(`Refusing to run integration tests against non-local host ${url.hostname}`);
  }
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  url.pathname = `/${name}`;
  const connectionString = url.toString();
  const setup = new pg.Client({ connectionString });
  await setup.connect();
  await setup.query(fs.readFileSync(FIXTURE, 'utf8'));
  await setup.end();
  return { connectionString, ssl: false, sslMode: 'disable' };
}
