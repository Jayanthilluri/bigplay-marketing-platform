// All SQL the pipeline runs. Built against the existing schema only:
//   admin.import_log, raw.google_ads_daily, staging.google_ads_daily,
//   core.dim_platform, core.dim_date, core.dim_campaign, core.fact_google_ads.
// No DDL. Idempotency comes from the existing unique constraints:
//   core.dim_campaign    UNIQUE (platform_key, source_campaign_id)
//   core.fact_google_ads UNIQUE (date_key, source_campaign_id, source_ad_group_id, source_ad_id)

import { DatabaseError } from '../errors.js';

export const SOURCE = 'google_ads';
export const SOURCE_TYPE = 'api';
export const PLATFORM_CODE = 'google';
// Arbitrary constant key for pg_try_advisory_lock: one Google Ads sync at a time.
const ADVISORY_LOCK_KEY = 7_420_001;
const CHUNK = 2000;

const REQUIRED_COLUMNS = {
  'admin.import_log': ['import_id', 'source', 'source_type', 'started_at', 'completed_at', 'business_date_start', 'business_date_end',
    'records_received', 'records_inserted', 'records_updated', 'records_rejected', 'status', 'error_message'],
  'raw.google_ads_daily': ['raw_id', 'import_id', 'business_date', 'customer_id', 'campaign_id', 'ad_group_id', 'ad_id', 'payload', 'received_at'],
  'staging.google_ads_daily': ['raw_id', 'import_id', 'business_date', 'customer_id', 'campaign_id', 'campaign_name', 'ad_group_id',
    'ad_group_name', 'ad_id', 'ad_name', 'impressions', 'clicks', 'spend', 'conversions', 'conversion_value', 'device', 'network', 'processed_at'],
  'core.dim_campaign': ['campaign_key', 'platform_key', 'source_campaign_id', 'campaign_name', 'objective', 'status', 'first_seen_date', 'last_seen_date'],
  'core.fact_google_ads': ['google_ads_key', 'date_key', 'campaign_key', 'source_campaign_id', 'source_ad_group_id', 'source_ad_id',
    'impressions', 'clicks', 'spend', 'conversions', 'conversion_value', 'imported_at'],
  'core.dim_date': ['date_key', 'full_date'],
  'core.dim_platform': ['platform_key', 'platform_code', 'platform_name'],
};

async function q(client, label, sql, params) {
  try {
    return await client.query(sql, params);
  } catch (err) {
    throw new DatabaseError(`Database error during ${label}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`, { cause: err });
  }
}

/**
 * Confirms the tables, columns and unique constraints the pipeline relies on
 * exist, and returns the Google platform key and dim_date coverage. Fails
 * before any write if the schema has drifted.
 */
export async function inspectSchema(client) {
  const { rows } = await q(client, 'schema inspection', `
    SELECT table_schema || '.' || table_name AS t, array_agg(column_name::text) AS cols
    FROM information_schema.columns
    WHERE (table_schema, table_name) IN (('admin','import_log'),('raw','google_ads_daily'),('staging','google_ads_daily'),
      ('core','dim_campaign'),('core','fact_google_ads'),('core','dim_date'),('core','dim_platform'))
    GROUP BY 1`);
  const found = new Map(rows.map((r) => [r.t, new Set(r.cols)]));
  const problems = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = found.get(table);
    if (!have) { problems.push(`missing table ${table}`); continue; }
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) problems.push(`${table} missing columns ${missing.join(', ')}`);
  }

  const uniq = await q(client, 'constraint inspection', `
    SELECT c.relname AS tbl, array_agg(a.attname::text ORDER BY a.attname) AS cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisunique AND n.nspname = 'core' AND c.relname IN ('dim_campaign','fact_google_ads')
    GROUP BY i.indexrelid, c.relname`);
  const hasUnique = (tbl, cols) => uniq.rows.some((r) => r.tbl === tbl && [...r.cols].sort().join() === [...cols].sort().join());
  if (!hasUnique('dim_campaign', ['platform_key', 'source_campaign_id'])) problems.push('core.dim_campaign lacks UNIQUE (platform_key, source_campaign_id)');
  if (!hasUnique('fact_google_ads', ['date_key', 'source_campaign_id', 'source_ad_group_id', 'source_ad_id'])) {
    problems.push('core.fact_google_ads lacks UNIQUE (date_key, source_campaign_id, source_ad_group_id, source_ad_id)');
  }

  const platform = await q(client, 'platform lookup', 'SELECT platform_key FROM core.dim_platform WHERE platform_code = $1', [PLATFORM_CODE]);
  if (!platform.rows.length) problems.push(`core.dim_platform has no row with platform_code = '${PLATFORM_CODE}'`);

  const bounds = await q(client, 'dim_date bounds', 'SELECT min(full_date) AS min, max(full_date) AS max, count(*)::int AS n FROM core.dim_date');
  if (!bounds.rows[0].n) problems.push('core.dim_date is empty');

  if (problems.length) throw new DatabaseError(`Database schema is not what the Google Ads pipeline expects: ${problems.join('; ')}`);
  return {
    platformKey: platform.rows[0].platform_key,
    dateBounds: { min: bounds.rows[0].min, max: bounds.rows[0].max },
  };
}

export async function tryAcquireLock(client) {
  const { rows } = await q(client, 'advisory lock', 'SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY]);
  return rows[0].ok;
}

export async function releaseLock(client) {
  await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
}

export async function createImportLog(client, { start, end }) {
  const { rows } = await q(client, 'import_log insert', `
    INSERT INTO admin.import_log (source, source_type, business_date_start, business_date_end, status)
    VALUES ($1, $2, $3, $4, 'running') RETURNING import_id`, [SOURCE, SOURCE_TYPE, start, end]);
  return rows[0].import_id;
}

export async function updateImportLog(client, importId, fields) {
  const allowed = ['status', 'business_date_start', 'business_date_end', 'records_received', 'records_inserted', 'records_updated', 'records_rejected', 'error_message'];
  const sets = [];
  const params = [importId];
  for (const k of allowed) {
    if (fields[k] !== undefined) { params.push(fields[k]); sets.push(`${k} = $${params.length}`); }
  }
  if (fields.complete) sets.push('completed_at = now()');
  if (!sets.length) return;
  await q(client, 'import_log update', `UPDATE admin.import_log SET ${sets.join(', ')} WHERE import_id = $1`, params);
}

async function chunked(items, fn) {
  let n = 0;
  for (let i = 0; i < items.length; i += CHUNK) n += await fn(items.slice(i, i + CHUNK));
  return n;
}

/** rows: [{ raw_id, business_date, customer_id, campaign_id, ad_group_id, ad_id, payload }] */
export async function insertRaw(client, importId, rows) {
  return chunked(rows, async (batch) => {
    const res = await q(client, 'raw insert', `
      INSERT INTO raw.google_ads_daily (raw_id, import_id, business_date, customer_id, campaign_id, ad_group_id, ad_id, payload)
      SELECT x.raw_id, $1, x.business_date, x.customer_id, x.campaign_id, x.ad_group_id, x.ad_id, x.payload
      FROM jsonb_to_recordset($2::jsonb) AS x(raw_id uuid, business_date date, customer_id text, campaign_id text,
                                              ad_group_id text, ad_id text, payload jsonb)`,
    [importId, JSON.stringify(batch)]);
    return res.rowCount;
  });
}

/** records: normalized staging records, each with raw_id. */
export async function insertStaging(client, importId, records) {
  const rows = records.map((r) => ({
    raw_id: r.raw_id, business_date: r.business_date, customer_id: r.customer_id,
    campaign_id: r.campaign_id, campaign_name: r.campaign_name, ad_group_id: r.ad_group_id, ad_group_name: r.ad_group_name,
    ad_id: r.ad_id, ad_name: r.ad_name, impressions: r.impressions, clicks: r.clicks, spend: r.spend,
    // Doubles from the API serialise exactly via String(); NUMERIC keeps them.
    conversions: String(r.conversions), conversion_value: String(r.conversion_value), device: r.device, network: r.network,
  }));
  return chunked(rows, async (batch) => {
    const res = await q(client, 'staging insert', `
      INSERT INTO staging.google_ads_daily (raw_id, import_id, business_date, customer_id, campaign_id, campaign_name,
        ad_group_id, ad_group_name, ad_id, ad_name, impressions, clicks, spend, conversions, conversion_value, device, network)
      SELECT x.raw_id, $1, x.business_date, x.customer_id, x.campaign_id, x.campaign_name, x.ad_group_id, x.ad_group_name,
             x.ad_id, x.ad_name, x.impressions, x.clicks, x.spend, x.conversions, x.conversion_value, x.device, x.network
      FROM jsonb_to_recordset($2::jsonb) AS x(raw_id uuid, business_date date, customer_id text, campaign_id text, campaign_name text,
        ad_group_id text, ad_group_name text, ad_id text, ad_name text, impressions bigint, clicks bigint, spend numeric,
        conversions numeric, conversion_value numeric, device text, network text)`,
    [importId, JSON.stringify(batch)]);
    return res.rowCount;
  });
}

/**
 * Upserts core.dim_campaign from this import's staging rows. Status and
 * channel type (stored as objective) come from the raw payload, since staging
 * has no columns for them. first/last_seen only ever widen, so a short
 * re-sync never shrinks a campaign's history.
 */
export async function upsertCampaigns(client, importId, platformKey) {
  const { rows } = await q(client, 'dim_campaign upsert', `
    WITH latest AS (
      SELECT DISTINCT ON (s.campaign_id)
             s.campaign_id, s.campaign_name,
             NULLIF(r.payload #>> '{row,campaign,advertisingChannelType}', '') AS objective,
             NULLIF(r.payload #>> '{row,campaign,status}', '') AS status
      FROM staging.google_ads_daily s
      LEFT JOIN raw.google_ads_daily r ON r.raw_id = s.raw_id
      WHERE s.import_id = $1
      ORDER BY s.campaign_id, s.business_date DESC, s.staging_id DESC
    ), span AS (
      SELECT campaign_id, min(business_date) AS first_seen, max(business_date) AS last_seen
      FROM staging.google_ads_daily WHERE import_id = $1 GROUP BY campaign_id
    )
    INSERT INTO core.dim_campaign AS d (platform_key, source_campaign_id, campaign_name, objective, status, first_seen_date, last_seen_date)
    SELECT $2, l.campaign_id, l.campaign_name, l.objective, l.status, s.first_seen, s.last_seen
    FROM latest l JOIN span s USING (campaign_id)
    ON CONFLICT (platform_key, source_campaign_id) DO UPDATE SET
      campaign_name   = COALESCE(EXCLUDED.campaign_name, d.campaign_name),
      objective       = COALESCE(EXCLUDED.objective, d.objective),
      status          = COALESCE(EXCLUDED.status, d.status),
      first_seen_date = LEAST(d.first_seen_date, EXCLUDED.first_seen_date),
      last_seen_date  = GREATEST(d.last_seen_date, EXCLUDED.last_seen_date)
    WHERE (d.campaign_name, d.objective, d.status, d.first_seen_date, d.last_seen_date)
          IS DISTINCT FROM
          (COALESCE(EXCLUDED.campaign_name, d.campaign_name), COALESCE(EXCLUDED.objective, d.objective),
           COALESCE(EXCLUDED.status, d.status), LEAST(d.first_seen_date, EXCLUDED.first_seen_date),
           GREATEST(d.last_seen_date, EXCLUDED.last_seen_date))
    RETURNING (xmax = 0) AS inserted`, [importId, platformKey]);
  const inserted = rows.filter((r) => r.inserted).length;
  const total = await q(client, 'campaign count', 'SELECT count(DISTINCT campaign_id)::int AS n FROM staging.google_ads_daily WHERE import_id = $1', [importId]);
  return { inserted, updated: rows.length - inserted, unchanged: total.rows[0].n - rows.length };
}

/**
 * Upserts core.fact_google_ads at its existing grain (date, campaign, ad group,
 * ad), summing this import's device/network segments. Rows whose values did
 * not change are left untouched (not counted as updated, imported_at kept).
 */
export async function upsertFacts(client, importId, platformKey) {
  const { rows } = await q(client, 'fact_google_ads upsert', `
    INSERT INTO core.fact_google_ads AS f (date_key, campaign_key, source_campaign_id, source_ad_group_id, source_ad_id,
                                           impressions, clicks, spend, conversions, conversion_value, imported_at)
    SELECT d.date_key, c.campaign_key, s.campaign_id, s.ad_group_id, s.ad_id,
           sum(s.impressions), sum(s.clicks), sum(s.spend), sum(s.conversions), sum(s.conversion_value), now()
    FROM staging.google_ads_daily s
    JOIN core.dim_date d ON d.full_date = s.business_date
    JOIN core.dim_campaign c ON c.platform_key = $2 AND c.source_campaign_id = s.campaign_id
    WHERE s.import_id = $1
    GROUP BY d.date_key, c.campaign_key, s.campaign_id, s.ad_group_id, s.ad_id
    ON CONFLICT (date_key, source_campaign_id, source_ad_group_id, source_ad_id) DO UPDATE SET
      campaign_key     = EXCLUDED.campaign_key,
      impressions      = EXCLUDED.impressions,
      clicks           = EXCLUDED.clicks,
      spend            = EXCLUDED.spend,
      conversions      = EXCLUDED.conversions,
      conversion_value = EXCLUDED.conversion_value,
      imported_at      = EXCLUDED.imported_at
    WHERE (f.campaign_key, f.impressions, f.clicks, f.spend, f.conversions, f.conversion_value)
          IS DISTINCT FROM
          (EXCLUDED.campaign_key, EXCLUDED.impressions, EXCLUDED.clicks, EXCLUDED.spend, EXCLUDED.conversions, EXCLUDED.conversion_value)
    RETURNING (xmax = 0) AS inserted`, [importId, platformKey]);
  const inserted = rows.filter((r) => r.inserted).length;
  const total = await q(client, 'fact grain count', `
    SELECT count(*)::int AS n FROM (SELECT 1 FROM staging.google_ads_daily WHERE import_id = $1
      GROUP BY business_date, campaign_id, ad_group_id, ad_id) g`, [importId]);
  return { inserted, updated: rows.length - inserted, unchanged: total.rows[0].n - rows.length, grainRows: total.rows[0].n };
}

const toDateKey = (iso) => Number(iso.replaceAll('-', ''));

/**
 * Post-load integrity checks. Every check is scoped to this import's date
 * window (or import_id) so it stays cheap as the tables grow.
 * Returns { checks: [{name, passed, severity, detail}], totals }.
 */
export async function validateLoad(client, { importId, start, end, platformKey, customerId }) {
  const ks = toDateKey(start);
  const ke = toDateKey(end);
  const checks = [];
  const add = (name, passed, detail, severity = 'error') => checks.push({ name, passed, severity, detail });
  const one = async (label, sql, params) => (await q(client, label, sql, params)).rows[0];

  const dup = await one('duplicate check', `
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM core.fact_google_ads WHERE date_key BETWEEN $1 AND $2
      GROUP BY date_key, source_campaign_id, source_ad_group_id, source_ad_id HAVING count(*) > 1) d`, [ks, ke]);
  add('no_duplicate_fact_rows', dup.n === 0, `${dup.n} duplicated logical keys`);

  const missingIds = await one('missing id check', `
    SELECT count(*)::int AS n FROM core.fact_google_ads WHERE date_key BETWEEN $1 AND $2
      AND (coalesce(source_campaign_id,'') = '' OR coalesce(source_ad_group_id,'') = '' OR coalesce(source_ad_id,'') = '')`, [ks, ke]);
  add('no_missing_identifiers', missingIds.n === 0, `${missingIds.n} fact rows missing campaign/ad group/ad id`);

  const orphanCampaign = await one('orphan campaign check', `
    SELECT count(*)::int AS n FROM core.fact_google_ads f
    LEFT JOIN core.dim_campaign c ON c.campaign_key = f.campaign_key
    WHERE f.date_key BETWEEN $1 AND $2
      AND (c.campaign_key IS NULL OR c.platform_key IS DISTINCT FROM $3 OR c.source_campaign_id IS DISTINCT FROM f.source_campaign_id)`,
  [ks, ke, platformKey]);
  add('no_orphan_campaign_keys', orphanCampaign.n === 0, `${orphanCampaign.n} fact rows with missing/mismatched campaign_key`);

  const orphanDate = await one('orphan date check', `
    SELECT (SELECT count(*) FROM core.fact_google_ads f WHERE f.date_key IS NULL
              OR NOT EXISTS (SELECT 1 FROM core.dim_date d WHERE d.date_key = f.date_key))::int AS n`);
  add('no_orphan_date_keys', orphanDate.n === 0, `${orphanDate.n} fact rows with missing date_key`);

  const negative = await one('negative spend check', `
    SELECT count(*)::int AS n FROM core.fact_google_ads WHERE date_key BETWEEN $1 AND $2
      AND (spend < 0 OR impressions < 0 OR clicks < 0)`, [ks, ke]);
  add('no_negative_spend', negative.n === 0, `${negative.n} fact rows with negative spend/impressions/clicks`);

  const badDates = await one('staging date check', `
    SELECT count(*)::int AS n FROM staging.google_ads_daily
    WHERE import_id = $1 AND (business_date IS NULL OR business_date < $2::date OR business_date > $3::date)`, [importId, start, end]);
  add('no_invalid_dates', badDates.n === 0, `${badDates.n} staging rows outside ${start}..${end}`);

  // Staging (this import) must equal core for exactly the keys this import loaded.
  const recon = await one('staging/core reconciliation', `
    WITH s AS (
      SELECT business_date, campaign_id, ad_group_id, ad_id, sum(impressions) i, sum(clicks) c, sum(spend) sp,
             sum(conversions) cv, sum(conversion_value) v
      FROM staging.google_ads_daily WHERE import_id = $1
      GROUP BY business_date, campaign_id, ad_group_id, ad_id)
    SELECT count(*)::int AS keys,
           count(*) FILTER (WHERE f.google_ads_key IS NULL)::int AS missing,
           count(*) FILTER (WHERE f.google_ads_key IS NOT NULL AND (f.impressions, f.clicks, f.spend, f.conversions, f.conversion_value)
                                     IS DISTINCT FROM (s.i, s.c, s.sp, s.cv, s.v))::int AS mismatched
    FROM s
    LEFT JOIN core.dim_date d ON d.full_date = s.business_date
    LEFT JOIN core.fact_google_ads f ON f.date_key = d.date_key AND f.source_campaign_id = s.campaign_id
      AND f.source_ad_group_id = s.ad_group_id AND f.source_ad_id = s.ad_id`, [importId]);
  add('staging_matches_core', recon.missing === 0 && recon.mismatched === 0,
    `${recon.keys} keys; ${recon.missing} missing in core; ${recon.mismatched} with different values`);

  // Rows already in core for this account's campaigns within the window that
  // Google no longer returned (e.g. fully restated to zero). Not deleted
  // automatically; surfaced for review.
  const stale = await one('stale row check', `
    SELECT count(*)::int AS n FROM core.fact_google_ads f
    JOIN core.dim_date d ON d.date_key = f.date_key
    WHERE f.date_key BETWEEN $1 AND $2
      AND EXISTS (SELECT 1 FROM raw.google_ads_daily r WHERE r.customer_id = $4 AND r.campaign_id = f.source_campaign_id)
      AND NOT EXISTS (SELECT 1 FROM staging.google_ads_daily s WHERE s.import_id = $3 AND s.business_date = d.full_date
                        AND s.campaign_id = f.source_campaign_id AND s.ad_group_id = f.source_ad_group_id AND s.ad_id = f.source_ad_id)`,
  [ks, ke, importId, customerId]);
  add('no_stale_fact_rows', stale.n === 0, `${stale.n} fact rows in window not returned by this sync`, 'warning');

  const totals = await one('totals', `
    SELECT (SELECT count(*) FROM raw.google_ads_daily WHERE import_id = $1)::int AS raw_rows,
           (SELECT count(*) FROM staging.google_ads_daily WHERE import_id = $1)::int AS staging_rows,
           count(*)::int AS fact_rows, coalesce(sum(impressions),0)::text AS impressions, coalesce(sum(clicks),0)::text AS clicks,
           coalesce(sum(spend),0)::text AS spend, coalesce(sum(conversions),0)::text AS conversions,
           coalesce(sum(conversion_value),0)::text AS conversion_value
    FROM core.fact_google_ads WHERE date_key BETWEEN $2 AND $3`, [importId, ks, ke]);
  return { checks, totals };
}

/** Dry run: how many of these fact keys already exist (read-only). */
export async function countExistingFactKeys(client, keys) {
  if (!keys.length) return 0;
  const { rows } = await q(client, 'existing key lookup', `
    SELECT count(*)::int AS n
    FROM jsonb_to_recordset($1::jsonb) AS k(business_date date, campaign_id text, ad_group_id text, ad_id text)
    JOIN core.dim_date d ON d.full_date = k.business_date
    JOIN core.fact_google_ads f ON f.date_key = d.date_key AND f.source_campaign_id = k.campaign_id
     AND f.source_ad_group_id = k.ad_group_id AND f.source_ad_id = k.ad_id`, [JSON.stringify(keys)]);
  return rows[0].n;
}

export async function countExistingCampaigns(client, platformKey, campaignIds) {
  if (!campaignIds.length) return 0;
  const { rows } = await q(client, 'existing campaign lookup',
    'SELECT count(*)::int AS n FROM core.dim_campaign WHERE platform_key = $1 AND source_campaign_id = ANY($2::text[])', [platformKey, campaignIds]);
  return rows[0].n;
}

/** Data-freshness summary for operators and, later, the dashboard. */
export async function freshness(client) {
  const { rows } = await q(client, 'freshness', `
    SELECT
      (SELECT row_to_json(x) FROM (SELECT import_id, status, started_at, completed_at, business_date_start, business_date_end,
              records_received, records_inserted, records_updated, records_rejected, error_message
         FROM admin.import_log WHERE source = $1 ORDER BY started_at DESC LIMIT 1) x) AS last_import,
      (SELECT row_to_json(x) FROM (SELECT import_id, status, started_at, completed_at, business_date_start, business_date_end,
              records_received, records_inserted, records_updated, records_rejected
         FROM admin.import_log WHERE source = $1 AND status = 'success' ORDER BY completed_at DESC LIMIT 1) x) AS last_successful_import,
      (SELECT max(completed_at) FROM admin.import_log WHERE source = $1 AND status IN ('success','partial')) AS last_data_load_at,
      (SELECT max(d.full_date) FROM core.fact_google_ads f JOIN core.dim_date d ON d.date_key = f.date_key) AS latest_business_date,
      (SELECT count(*) FROM core.fact_google_ads)::int AS fact_rows`, [SOURCE]);
  return rows[0];
}
