import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, normalizeCustomerId } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';
import { redact } from '../../src/logger.js';

const full = {
  GOOGLE_ADS_CLIENT_ID: 'client-id-123.apps.googleusercontent.com',
  GOOGLE_ADS_CLIENT_SECRET: 'super-secret-client',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token-abcdef',
  GOOGLE_ADS_REFRESH_TOKEN: '1//refresh-token-xyz',
  GOOGLE_ADS_CUSTOMER_ID: '123-456-7890, 2345678901',
  SUPABASE_DB_URL: 'postgresql://postgres.ref:p%40ssw0rd-long@aws-0.pooler.supabase.com:5432/postgres?sslmode=require',
};

test('missing variables are named, values never echoed', () => {
  const env = { ...full };
  delete env.GOOGLE_ADS_REFRESH_TOKEN;
  delete env.SUPABASE_DB_URL;
  try {
    loadConfig(env);
    assert.fail('expected ConfigError');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /GOOGLE_ADS_REFRESH_TOKEN, SUPABASE_DB_URL/);
    assert.doesNotMatch(err.message, /super-secret-client/);
  }
});

test('parses customer IDs, defaults lookback to 7 and API version to v25', () => {
  const c = loadConfig(full);
  assert.deepEqual(c.google.customerIds, ['1234567890', '2345678901']);
  assert.equal(c.lookbackDays, 7);
  assert.equal(c.google.apiVersion, 'v25');
  assert.equal(c.db.connectionString.includes('sslmode'), false);
  assert.equal(loadConfig({ ...full, GOOGLE_ADS_LOOKBACK_DAYS: '14' }).lookbackDays, 14);
  assert.throws(() => loadConfig({ ...full, GOOGLE_ADS_LOOKBACK_DAYS: 'seven' }), ConfigError);
  assert.throws(() => normalizeCustomerId('12345'), ConfigError);
});

test('dry-run style config does not need database credentials', () => {
  const env = { ...full };
  delete env.SUPABASE_DB_URL;
  assert.equal(loadConfig(env, { requireDb: false }).db, null);
});

test('secrets are redacted from any logged text once config is loaded', () => {
  loadConfig(full);
  const leaked = `token=1//refresh-token-xyz secret=super-secret-client dev=dev-token-abcdef auth: Bearer ya29.a0AfH6abc url=${full.SUPABASE_DB_URL}`;
  const out = redact(leaked);
  for (const s of ['1//refresh-token-xyz', 'super-secret-client', 'dev-token-abcdef', 'ya29.a0AfH6abc', 'p%40ssw0rd-long']) {
    assert.equal(out.includes(s), false, s);
  }
});
