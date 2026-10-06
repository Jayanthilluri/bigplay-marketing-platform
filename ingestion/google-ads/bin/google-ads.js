#!/usr/bin/env node
// Google Ads ingestion CLI. Server-side only.
//
//   node bin/google-ads.js test-connection         Supabase Postgres + schema check
//   node bin/google-ads.js test-auth               Google OAuth + account access check
//   node bin/google-ads.js sync [--dry-run]        default lookback (GOOGLE_ADS_LOOKBACK_DAYS, 7)
//   node bin/google-ads.js sync --start 2026-09-01 --end 2026-09-03
//   node bin/google-ads.js backfill --days 90 [--dry-run]
//   node bin/google-ads.js status                  last import / freshness
//
// Flags: --customer <id> (one of GOOGLE_ADS_CUSTOMER_ID), --json
// Exit codes: 0 success, 1 failed, 2 partial (rows rejected), 3 another sync is running.

import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { loadConfig, normalizeCustomerId } from '../src/config.js';
import { resolveDateRange, splitRange, todayInTimeZone } from '../src/dateRange.js';
import { ConcurrentRunError, ConfigError } from '../src/errors.js';
import { describeError, logger, redact } from '../src/logger.js';
import { GoogleAdsClient } from '../src/googleAds/client.js';
import { connect } from '../src/db/connection.js';
import * as repo from '../src/db/repository.js';
import { fetchAccount, syncCustomer } from '../src/pipeline/sync.js';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname, quiet: true });

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    start: { type: 'string' },
    end: { type: 'string' },
    days: { type: 'string' },
    customer: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const command = positionals[0];

function print(title, obj) {
  if (args.json) return;
  process.stdout.write(`\n=== ${title} ===\n${redact(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))}\n`);
}

function parseDays() {
  if (args.days === undefined) return undefined;
  if (!/^\d+$/.test(args.days)) throw new ConfigError(`--days must be a non-negative integer, got "${args.days}"`);
  return Number(args.days);
}

function selectCustomers(config) {
  if (!args.customer) return config.google.customerIds;
  const id = normalizeCustomerId(args.customer);
  if (!config.google.customerIds.includes(id)) throw new ConfigError(`--customer ${id} is not listed in GOOGLE_ADS_CUSTOMER_ID`);
  return [id];
}

function summarize(report) {
  const c = report.counts;
  const out = {
    status: report.status,
    import_id: report.importId,
    customer_id: report.customerId,
    account: report.account && `${report.account.name} (${report.account.currencyCode}, ${report.account.timeZone})`,
    date_range: report.range && `${report.range.start} .. ${report.range.end} (${report.range.days} days)`,
    api_records_received: c.api_records_received,
    raw_records_written: c.raw_written,
    staging_records_processed: c.staging_written,
    records_rejected: c.records_rejected,
    campaigns: { seen: c.campaigns, inserted: c.campaigns_inserted, updated: c.campaigns_updated, unchanged: c.campaigns_unchanged },
    facts: { grain_rows: c.fact_grain_rows, inserted: c.facts_inserted, updated: c.facts_updated, unchanged: c.facts_unchanged },
    totals_from_api_accepted_rows: report.totals.api_accepted,
    totals_in_core_for_window: report.totals.core_window,
    checks: report.checks.map((k) => `${k.passed ? 'PASS' : k.severity === 'warning' ? 'WARN' : 'FAIL'} ${k.name}: ${k.detail}`),
    warnings: report.warnings,
    error: report.errorMessage ?? undefined,
  };
  if (report.dryRun) {
    out.would_insert_facts = c.would_insert_facts;
    out.would_update_or_keep_facts = c.would_update_or_keep_facts;
    out.would_insert_campaigns = c.would_insert_campaigns;
    out.preview_fact_rows = report.preview;
    out.rejected_samples = report.rejectedSamples;
  }
  return out;
}

async function withDb(config, fn) {
  const db = await connect(config.db);
  try { return await fn(db); } finally { await db.end().catch(() => {}); }
}

async function testConnection() {
  const config = loadConfig(process.env, { requireGoogle: false });
  return withDb(config, async (db) => {
    const { rows } = await db.query('SELECT current_database() AS db, current_user AS usr, version() AS version');
    const schema = await repo.inspectSchema(db);
    print('Supabase connection OK', { database: rows[0].db, user: rows[0].usr, ssl: config.db.sslMode, version: rows[0].version.split(' on ')[0], ...schema });
    return 0;
  });
}

async function testAuth() {
  const config = loadConfig(process.env, { requireDb: false });
  const google = new GoogleAdsClient(config.google);
  await google.getAccessToken();
  const accounts = [];
  for (const id of config.google.customerIds) accounts.push(await fetchAccount(google, id));
  print('Google Ads authentication OK', {
    api_version: config.google.apiVersion, login_customer_id: config.google.loginCustomerId, accounts,
    today_in_account_tz: accounts.map((a) => ({ id: a.id, today: todayInTimeZone(a.timeZone) })),
  });
  return 0;
}

async function runSyncs({ backfill }) {
  const dryRun = args['dry-run'];
  // A dry run can work without database credentials; it then skips the
  // insert-vs-update preview and the dim_date coverage check.
  const config = loadConfig(process.env, { requireDb: !dryRun || Boolean(process.env.SUPABASE_DB_URL) });
  const google = new GoogleAdsClient(config.google);
  const customers = selectCustomers(config);
  const days = parseDays();
  if (backfill && days === undefined && !args.start) throw new ConfigError('backfill needs --days N or --start/--end');

  const db = config.db ? await connect(config.db) : null;
  let locked = false;
  const reports = [];
  try {
    const schema = db ? await repo.inspectSchema(db) : null;
    if (db && !dryRun) {
      locked = await repo.tryAcquireLock(db);
      if (!locked) throw new ConcurrentRunError('Another Google Ads sync holds the lock; exiting without changes.');
    }
    for (const customerId of customers) {
      let windows = [{ start: args.start, end: args.end, days }];
      if (backfill) {
        const account = await fetchAccount(google, customerId);
        const full = resolveDateRange({ today: todayInTimeZone(account.timeZone), start: args.start, end: args.end, days });
        windows = splitRange(full, config.backfillChunkDays);
        logger.info('backfill.plan', { customerId, ...full, chunks: windows.length, chunkDays: config.backfillChunkDays });
      }
      for (const w of windows) {
        const report = await syncCustomer({
          google, db, schema, customerId, dryRun, lookbackDays: config.lookbackDays,
          start: w.start, end: w.end, days: w.start ? undefined : w.days,
        });
        reports.push(report);
        print(`${dryRun ? 'DRY RUN' : 'SYNC'} ${customerId} ${report.range.start}..${report.range.end}`, summarize(report));
        if (report.status === 'failed') {
          logger.error('sync.stopped', { customerId, reason: 'integrity checks failed; later windows not attempted', importId: report.importId });
          break;
        }
      }
    }
  } catch (err) {
    if (err.report) {
      reports.push(err.report);
      print(`FAILED ${err.report.customerId}`, summarize(err.report));
    }
    throw err;
  } finally {
    if (locked) await repo.releaseLock(db);
    if (db) await db.end().catch(() => {});
    print('Google Ads API usage', google.stats);
    if (args.json) process.stdout.write(JSON.stringify(reports.map(summarize), null, 2) + '\n');
  }
  if (reports.some((r) => r.status === 'failed')) return 1;
  return reports.some((r) => String(r.status).includes('partial')) ? 2 : 0;
}

async function status() {
  const config = loadConfig(process.env, { requireGoogle: false });
  return withDb(config, async (db) => {
    const f = await repo.freshness(db);
    print('Google Ads data freshness', f);
    if (args.json) process.stdout.write(JSON.stringify(f, null, 2) + '\n');
    return 0;
  });
}

const commands = {
  'test-connection': testConnection,
  'test-auth': testAuth,
  sync: () => runSyncs({ backfill: false }),
  backfill: () => runSyncs({ backfill: true }),
  status,
};

if (!commands[command]) {
  process.stderr.write(`Usage: node bin/google-ads.js <${Object.keys(commands).join('|')}> [--dry-run] [--start YYYY-MM-DD --end YYYY-MM-DD] [--days N] [--customer ID] [--json]\n`);
  process.exit(1);
}

try {
  process.exitCode = await commands[command]();
} catch (err) {
  logger.error('command.failed', { command, error: describeError(err) });
  process.exitCode = err instanceof ConcurrentRunError ? 3 : 1;
}
