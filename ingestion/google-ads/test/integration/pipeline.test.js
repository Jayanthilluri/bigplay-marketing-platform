// End-to-end pipeline tests against a local Postgres loaded with a replica of
// the live schema. Run with:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:54329/postgres npm run test:integration

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAdsClient } from '../../src/googleAds/client.js';
import { GoogleAdsAuthError } from '../../src/errors.js';
import { connect } from '../../src/db/connection.js';
import * as repo from '../../src/db/repository.js';
import { syncCustomer } from '../../src/pipeline/sync.js';
import { ACCOUNT_ROW, CUSTOMER_ID, FakeGoogleAds, adRow, campaignRow, campaignRowsFor } from '../helpers/fixtures.js';
import { TEST_DATABASE_URL, createTestDatabase } from '../helpers/testDb.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date('2026-10-06T16:00:00Z'); // 12:00 in America/New_York
const RANGE = { start: '2026-10-01', end: '2026-10-03' };

const baseRows = () => [
  adRow({ date: '2026-10-01', device: 'MOBILE', impressions: '1000', clicks: '40', costMicros: '10000000', conversions: 2, conversionsValue: 100 }),
  adRow({ date: '2026-10-01', device: 'DESKTOP', impressions: '500', clicks: '10', costMicros: '5500000', conversions: 1, conversionsValue: 50 }),
  adRow({ date: '2026-10-02', device: 'MOBILE', impressions: '800', clicks: '30', costMicros: '7250000', conversions: 0.5, conversionsValue: 20.25 }),
  adRow({ date: '2026-10-02', adId: '334', adName: 'RSA 2', impressions: '300', clicks: '3', costMicros: '1000000', conversions: null, conversionsValue: null }),
  adRow({ date: '2026-10-03', campaignId: '555', campaignName: 'Birthday Parties', adGroupId: '666', adId: '777', impressions: '200', clicks: '20', costMicros: '4000000', conversions: 4, conversionsValue: 400 }),
];

describe('Google Ads pipeline (local Postgres, live-schema replica)', { skip: !TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, () => {
  let db;
  let dbConfig;
  let schema;
  const sql = async (text, params) => (await db.query(text, params)).rows;
  const run = (google, opts = {}) => syncCustomer({ google, db, schema, customerId: CUSTOMER_ID, now: NOW, logger: quiet, ...RANGE, ...opts });

  before(async () => {
    dbConfig = await createTestDatabase('bigplay_gads_it');
    db = await connect(dbConfig);
    schema = await repo.inspectSchema(db);
  });
  after(async () => { await db?.end(); });

  test('schema inspection finds the google platform and dim_date coverage', () => {
    assert.equal(schema.platformKey, 1);
    assert.deepEqual(schema.dateBounds, { min: '2024-01-01', max: '2030-12-31' });
  });

  test('dry run reads Google, validates, previews and writes nothing', async () => {
    const report = await run(new FakeGoogleAds({ rows: baseRows() }), { dryRun: true });
    assert.equal(report.status, 'dry-run (would be success)');
    assert.equal(report.counts.api_records_received, 5);
    assert.equal(report.counts.fact_grain_rows, 4);
    assert.equal(report.counts.would_insert_facts, 4);
    assert.equal(report.counts.would_insert_campaigns, 2);
    assert.equal(report.preview.length, 4);
    for (const t of ['admin.import_log', 'raw.google_ads_daily', 'staging.google_ads_daily', 'core.dim_campaign', 'core.fact_google_ads']) {
      assert.equal((await sql(`SELECT count(*)::int n FROM ${t}`))[0].n, 0, t);
    }
  });

  test('first sync loads raw -> staging -> dim_campaign -> fact and logs success', async () => {
    const report = await run(new FakeGoogleAds({ rows: baseRows() }));
    assert.equal(report.status, 'success');
    assert.deepEqual(
      [report.counts.raw_written, report.counts.staging_written, report.counts.facts_inserted, report.counts.facts_updated, report.counts.campaigns_inserted],
      [5, 5, 4, 0, 2],
    );
    assert.ok(report.checks.every((c) => c.passed), JSON.stringify(report.checks));

    const [log] = await sql('SELECT * FROM admin.import_log WHERE import_id = $1', [report.importId]);
    assert.equal(log.source, 'google_ads');
    assert.equal(log.source_type, 'api');
    assert.equal(log.status, 'success');
    assert.ok(log.completed_at);
    assert.deepEqual([log.business_date_start, log.business_date_end], ['2026-10-01', '2026-10-03']);
    assert.deepEqual([log.records_received, log.records_inserted, log.records_updated, log.records_rejected], [5, 4, 0, 0]);
    assert.equal(log.error_message, null);

    const [raw] = await sql("SELECT * FROM raw.google_ads_daily WHERE ad_id = '777'");
    assert.deepEqual([raw.business_date, raw.customer_id, raw.campaign_id, raw.ad_group_id], ['2026-10-03', CUSTOMER_ID, '555', '666']);
    assert.equal(raw.payload.row.campaign.name, 'Birthday Parties');
    assert.equal(raw.payload.api_version, 'v25');

    const staged = await sql("SELECT * FROM staging.google_ads_daily WHERE import_id = $1 AND ad_id = '333' ORDER BY business_date, device", [report.importId]);
    assert.equal(staged.length, 3);
    assert.deepEqual([staged[0].device, staged[0].spend, staged[0].network], ['DESKTOP', '5.5', 'SEARCH']);
    assert.ok(staged.every((s) => s.raw_id));

    const camps = await sql('SELECT * FROM core.dim_campaign ORDER BY source_campaign_id');
    assert.deepEqual(camps.map((c) => [c.platform_key, c.source_campaign_id, c.campaign_name, c.objective, c.status, c.first_seen_date, c.last_seen_date]), [
      [1, '111', 'Fall Bowling Promo', 'SEARCH', 'ENABLED', '2026-10-01', '2026-10-02'],
      [1, '555', 'Birthday Parties', 'SEARCH', 'ENABLED', '2026-10-03', '2026-10-03'],
    ]);

    // device segments summed into one fact row at the existing grain
    const [f] = await sql("SELECT * FROM core.fact_google_ads WHERE date_key = 20261001 AND source_ad_id = '333'");
    assert.deepEqual([f.impressions, f.clicks, f.spend, f.conversions, f.conversion_value], ['1500', '50', '15.5', '3', '150']);
    assert.equal(f.campaign_key, camps[0].campaign_key);
  });

  test('re-running the same window creates no duplicates and updates nothing', async () => {
    const report = await run(new FakeGoogleAds({ rows: baseRows() }));
    assert.equal(report.status, 'success');
    assert.deepEqual([report.counts.facts_inserted, report.counts.facts_updated, report.counts.facts_unchanged], [0, 0, 4]);
    assert.deepEqual([report.counts.campaigns_inserted, report.counts.campaigns_updated], [0, 0]);
    assert.equal((await sql('SELECT count(*)::int n FROM core.fact_google_ads'))[0].n, 4);
    assert.equal((await sql('SELECT count(*)::int n FROM core.dim_campaign'))[0].n, 2);
    // raw/staging are append-only per import (lineage), core is not
    assert.equal((await sql('SELECT count(*)::int n FROM raw.google_ads_daily'))[0].n, 10);
    const [log] = await sql('SELECT * FROM admin.import_log WHERE import_id = $1', [report.importId]);
    assert.deepEqual([log.records_inserted, log.records_updated], [0, 0]);
  });

  test('restated conversions and renamed campaigns update in place', async () => {
    const rows = baseRows();
    rows[0].metrics.conversions = 5; // late attribution
    rows.forEach((r) => { if (r.campaign.id === '111') r.campaign.name = 'Fall Bowling Promo 2026'; });
    const report = await run(new FakeGoogleAds({ rows }));
    assert.deepEqual([report.counts.facts_inserted, report.counts.facts_updated, report.counts.facts_unchanged], [0, 1, 3]);
    assert.equal(report.counts.campaigns_updated, 1);
    const [f] = await sql("SELECT conversions FROM core.fact_google_ads WHERE date_key = 20261001 AND source_ad_id = '333'");
    assert.equal(f.conversions, '6');
    const camps = await sql("SELECT campaign_name FROM core.dim_campaign WHERE source_campaign_id = '111'");
    assert.deepEqual(camps.map((c) => c.campaign_name), ['Fall Bowling Promo 2026']);
  });

  test('an earlier backfill window widens first_seen_date without duplicating the campaign', async () => {
    const report = await run(new FakeGoogleAds({ rows: [adRow({ date: '2026-07-15' })] }), { start: '2026-07-01', end: '2026-07-31' });
    assert.equal(report.status, 'success');
    const [c] = await sql("SELECT * FROM core.dim_campaign WHERE source_campaign_id = '111'");
    assert.deepEqual([c.first_seen_date, c.last_seen_date], ['2026-07-15', '2026-10-02']);
    assert.equal((await sql("SELECT count(*)::int n FROM core.dim_campaign WHERE source_campaign_id = '111'"))[0].n, 1);
  });

  test('invalid rows are rejected and logged; valid rows still load; status partial', async () => {
    const bad1 = adRow({ date: '2026-10-03', adId: '901', impressions: 'lots' });
    const bad2 = adRow({ date: '2026-10-03', adId: '902' });
    delete bad2.campaign.id;
    const good = adRow({ date: '2026-10-03', adId: '903', impressions: '10', costMicros: '100000' });
    const report = await run(new FakeGoogleAds({ rows: [...baseRows(), bad1, bad2, good], campaignRows: campaignRowsFor([...baseRows(), good]) }));
    assert.equal(report.status, 'partial');
    assert.equal(report.counts.records_rejected, 2);
    assert.equal(report.counts.raw_written, 8, 'rejected rows are still preserved in raw');
    assert.equal(report.counts.staging_written, 6);
    assert.equal(report.counts.facts_inserted, 1);
    const [log] = await sql('SELECT * FROM admin.import_log WHERE import_id = $1', [report.importId]);
    assert.equal(log.status, 'partial');
    assert.equal(log.records_rejected, 2);
    assert.match(log.error_message, /2 of 8 rows rejected: .*impressions is not an integer.*campaign\.id/);
    assert.equal((await sql("SELECT count(*)::int n FROM core.fact_google_ads WHERE source_ad_id IN ('901','902')"))[0].n, 0);
  });

  test('an API failure marks the import failed with the error and leaves core untouched', async () => {
    const before = await sql('SELECT count(*)::int n, sum(spend)::text s FROM core.fact_google_ads');
    const err = new GoogleAdsAuthError('Google OAuth failed: refresh token is expired or revoked (invalid_grant)');
    await assert.rejects(run(new FakeGoogleAds({ rows: baseRows(), failWith: err })), GoogleAdsAuthError);
    const [log] = await sql('SELECT * FROM admin.import_log ORDER BY started_at DESC LIMIT 1');
    assert.equal(log.status, 'failed');
    assert.ok(log.completed_at);
    assert.match(log.error_message, /invalid_grant/);
    assert.deepEqual(await sql('SELECT count(*)::int n, sum(spend)::text s FROM core.fact_google_ads'), before);
  });

  test('a database failure mid-load rolls back staging and core, keeps raw, logs failed', async () => {
    const before = await sql('SELECT count(*)::int n FROM core.fact_google_ads');
    const stagingBefore = await sql('SELECT count(*)::int n FROM staging.google_ads_daily');
    // Make dim_campaign reject one campaign so the load fails after raw is committed.
    await db.query("ALTER TABLE core.dim_campaign ADD CONSTRAINT it_block CHECK (source_campaign_id <> '4242') NOT VALID");
    try {
      await assert.rejects(run(new FakeGoogleAds({ rows: [...baseRows(), adRow({ date: '2026-10-02', campaignId: '4242' })] })), /dim_campaign upsert/);
    } finally {
      await db.query('ALTER TABLE core.dim_campaign DROP CONSTRAINT it_block');
    }
    const [log] = await sql('SELECT * FROM admin.import_log ORDER BY started_at DESC LIMIT 1');
    assert.equal(log.status, 'failed');
    assert.match(log.error_message, /DatabaseError: Database error during dim_campaign upsert/);
    assert.deepEqual(await sql('SELECT count(*)::int n FROM core.fact_google_ads'), before);
    assert.deepEqual(await sql('SELECT count(*)::int n FROM staging.google_ads_daily'), stagingBefore);
    assert.equal((await sql('SELECT count(*)::int n FROM raw.google_ads_daily WHERE import_id = $1', [log.import_id]))[0].n, 6);
  });

  test('a failed integrity check rolls back core and marks the import failed', async () => {
    // A pre-existing fact row with a NULL ad id in the window (the unique
    // constraint cannot stop NULLs) must block the import from succeeding.
    const [camp] = await sql("SELECT campaign_key FROM core.dim_campaign WHERE source_campaign_id = '111'");
    await db.query("INSERT INTO core.fact_google_ads (date_key, campaign_key, source_campaign_id, source_ad_group_id, source_ad_id) VALUES (20261002, $1, '111', '222', NULL)", [camp.campaign_key]);
    try {
      const rows = baseRows();
      rows[2].metrics.clicks = '31'; // a change that must NOT be committed
      const report = await run(new FakeGoogleAds({ rows }));
      assert.equal(report.status, 'failed');
      assert.ok(report.checks.find((c) => c.name === 'no_missing_identifiers' && !c.passed));
      const [log] = await sql('SELECT * FROM admin.import_log WHERE import_id = $1', [report.importId]);
      assert.equal(log.status, 'failed');
      assert.match(log.error_message, /Integrity checks failed; core changes rolled back.*no_missing_identifiers: 1 fact rows/);
      assert.equal(log.records_inserted, 0);
      const [f] = await sql("SELECT clicks FROM core.fact_google_ads WHERE date_key = 20261002 AND source_ad_id = '333'");
      assert.equal(f.clicks, '30');
      assert.equal((await sql('SELECT count(*)::int n FROM staging.google_ads_daily WHERE import_id = $1', [report.importId]))[0].n, 0);
    } finally {
      await db.query('DELETE FROM core.fact_google_ads WHERE source_ad_id IS NULL');
    }
  });

  test('campaigns with spend but no ad-level rows (PMax) are reported as warnings', async () => {
    const rows = baseRows();
    const report = await run(new FakeGoogleAds({
      rows,
      campaignRows: [...campaignRowsFor(rows), campaignRow({ date: '2026-10-02', campaignId: '888', campaignName: 'PMax', channel: 'PERFORMANCE_MAX', costMicros: '9990000' })],
    }));
    assert.equal(report.status, 'success');
    assert.equal(report.campaignCoverageGaps.length, 1);
    assert.match(report.warnings.join('\n'), /campaign 888 \(PERFORMANCE_MAX\) has 9.99 USD/);
  });

  test('the real REST client (mocked transport) paginates into the database', async () => {
    const rows = baseRows();
    const pages = [rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)];
    const fetchImpl = async (url, init) => {
      if (String(url).includes('oauth2')) return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
      const { query, pageToken } = JSON.parse(init.body);
      if (query.includes('FROM customer')) return Response.json({ results: [ACCOUNT_ROW] });
      if (query.includes('FROM campaign')) return Response.json({ results: campaignRowsFor(rows) });
      const i = pageToken ? Number(pageToken) : 0;
      return Response.json({ results: pages[i], ...(i < pages.length - 1 ? { nextPageToken: String(i + 1) } : {}) });
    };
    const google = new GoogleAdsClient({ clientId: 'a', clientSecret: 'b', developerToken: 'c', refreshToken: 'd', apiVersion: 'v25', maxRetries: 2 }, { fetchImpl, logger: quiet });
    const report = await run(google);
    assert.equal(report.counts.api_records_received, 5);
    assert.equal(report.status, 'success');
    assert.equal(google.stats.pages, 5); // customer + 3 ad pages + campaign totals
  });

  test('default 7-day lookback uses the account time zone', async () => {
    const report = await syncCustomer({ google: new FakeGoogleAds({ rows: [] }), db, schema, customerId: CUSTOMER_ID, now: new Date('2026-10-07T02:00:00Z'), logger: quiet, dryRun: true });
    assert.deepEqual(report.range, { start: '2026-09-29', end: '2026-10-06', days: 8 });
  });

  test('integrity checks pass and analytics views read the loaded data', async () => {
    const checks = await repo.validateLoad(db, { importId: '00000000-0000-0000-0000-000000000000', start: '2026-07-01', end: '2026-10-06', platformKey: 1, customerId: CUSTOMER_ID });
    for (const c of checks.checks.filter((x) => x.name !== 'staging_matches_core' && x.name !== 'no_stale_fact_rows')) assert.ok(c.passed, `${c.name}: ${c.detail}`);
    const dup = await sql(`SELECT count(*)::int n FROM (SELECT 1 FROM core.fact_google_ads
      GROUP BY date_key, source_campaign_id, source_ad_group_id, source_ad_id HAVING count(*) > 1) d`);
    assert.equal(dup[0].n, 0);

    const perf = await sql("SELECT * FROM analytics.google_campaign_performance WHERE date = '2026-10-01'");
    assert.equal(perf.length, 1);
    // Later syncs returned the original name again: the latest name from Google wins.
    assert.deepEqual([perf[0].platform, perf[0].campaign_id, perf[0].campaign_name, perf[0].spend], ['google', '111', 'Fall Bowling Promo', '15.5']);
    const daily = await sql("SELECT platform, sum(spend)::text spend FROM analytics.daily_marketing_performance WHERE date BETWEEN '2026-10-01' AND '2026-10-03' GROUP BY platform");
    const facts = await sql('SELECT sum(spend)::text spend FROM core.fact_google_ads WHERE date_key BETWEEN 20261001 AND 20261003');
    assert.deepEqual(daily, [{ platform: 'google', spend: facts[0].spend }]);
    assert.equal((await sql('SELECT count(*)::int n FROM analytics.platform_comparison'))[0].n > 0, true);
    const [fresh] = await sql("SELECT * FROM analytics.data_freshness WHERE source = 'Google Ads'");
    assert.equal(fresh.data_through_date, '2026-10-03');
  });

  test('freshness summary exposes last import, last success and latest business date', async () => {
    const f = await repo.freshness(db);
    assert.ok(f.last_import);
    assert.equal(f.last_successful_import.status, 'success');
    assert.equal(f.latest_business_date, '2026-10-03');
    assert.ok(f.fact_rows >= 5);
  });

  test('only one sync can hold the lock at a time', async () => {
    const other = await connect(dbConfig);
    try {
      assert.equal(await repo.tryAcquireLock(db), true);
      assert.equal(await repo.tryAcquireLock(other), false);
      await repo.releaseLock(db);
      assert.equal(await repo.tryAcquireLock(other), true);
      await repo.releaseLock(other);
    } finally {
      await other.end();
    }
  });
});
