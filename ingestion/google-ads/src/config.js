import fs from 'node:fs';
import { ConfigError } from './errors.js';
import { registerSecret } from './logger.js';

const GOOGLE_REQUIRED = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
];
const DB_REQUIRED = ['SUPABASE_DB_URL'];

// Google Ads customer IDs are 10 digits, often written 123-456-7890.
export function normalizeCustomerId(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(digits)) {
    throw new ConfigError(`Invalid Google Ads customer ID "${value}": expected 10 digits (e.g. 123-456-7890)`);
  }
  return digits;
}

function positiveInt(env, name, fallback, { max } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw).trim())) throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  const n = Number(raw);
  if (n < 1 || (max && n > max)) throw new ConfigError(`${name} must be between 1 and ${max ?? '∞'}, got ${n}`);
  return n;
}

/**
 * Validates and returns runtime configuration. Fails with a ConfigError that
 * names every missing variable (never their values) so a misconfigured
 * scheduler fails loudly at startup instead of mid-import.
 */
export function loadConfig(env = process.env, { requireGoogle = true, requireDb = true } = {}) {
  const required = [...(requireGoogle ? GOOGLE_REQUIRED : []), ...(requireDb ? DB_REQUIRED : [])];
  const missing = required.filter((name) => !env[name] || !String(env[name]).trim());
  if (missing.length) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}. See ingestion/google-ads/.env.example.`);
  }

  const config = {
    google: null,
    db: null,
    lookbackDays: positiveInt(env, 'GOOGLE_ADS_LOOKBACK_DAYS', 7, { max: 3650 }),
    backfillChunkDays: positiveInt(env, 'GOOGLE_ADS_BACKFILL_CHUNK_DAYS', 30, { max: 365 }),
  };

  if (requireGoogle) {
    for (const name of ['GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CLIENT_ID']) {
      registerSecret(env[name]);
    }
    const apiVersion = (env.GOOGLE_ADS_API_VERSION || 'v25').trim();
    if (!/^v\d+$/.test(apiVersion)) throw new ConfigError(`GOOGLE_ADS_API_VERSION must look like "v25", got "${apiVersion}"`);
    config.google = {
      clientId: env.GOOGLE_ADS_CLIENT_ID.trim(),
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET.trim(),
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN.trim(),
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN.trim(),
      customerIds: [...new Set(env.GOOGLE_ADS_CUSTOMER_ID.split(',').map((s) => s.trim()).filter(Boolean).map(normalizeCustomerId))],
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) : null,
      apiVersion,
      maxRetries: positiveInt(env, 'GOOGLE_ADS_MAX_RETRIES', 5, { max: 10 }),
    };
  }

  if (requireDb) {
    const url = env.SUPABASE_DB_URL.trim();
    registerSecret(url);
    const passwordMatch = url.match(/^postgres(?:ql)?:\/\/[^:/]+:([^@]+)@/);
    if (passwordMatch) {
      registerSecret(passwordMatch[1]);
      try { registerSecret(decodeURIComponent(passwordMatch[1])); } catch { /* not URI-encoded */ }
    }
    if (!/^postgres(ql)?:\/\//.test(url)) throw new ConfigError('SUPABASE_DB_URL must be a postgres:// connection string');

    const sslMode = (env.SUPABASE_DB_SSL || 'require').trim().toLowerCase();
    let ssl;
    if (sslMode === 'disable') ssl = false;
    else if (sslMode === 'require') ssl = { rejectUnauthorized: false };
    else if (sslMode === 'verify') {
      const caFile = env.SUPABASE_DB_SSL_CA_FILE;
      if (!caFile) throw new ConfigError('SUPABASE_DB_SSL=verify requires SUPABASE_DB_SSL_CA_FILE (Supabase dashboard → Database → SSL certificate)');
      ssl = { rejectUnauthorized: true, ca: fs.readFileSync(caFile, 'utf8') };
    } else throw new ConfigError(`SUPABASE_DB_SSL must be disable, require or verify, got "${sslMode}"`);

    // pg treats sslmode in the URL as authoritative over the ssl object; strip
    // it so SUPABASE_DB_SSL is the single switch.
    config.db = { connectionString: url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''), ssl, sslMode };
  }

  return config;
}
