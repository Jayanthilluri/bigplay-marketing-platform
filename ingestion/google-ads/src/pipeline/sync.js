// Google Ads API -> admin.import_log -> raw -> staging -> core.dim_campaign
// -> core.fact_google_ads, for one customer and one date window.

import { randomUUID } from 'node:crypto';
import { resolveDateRange, todayInTimeZone } from '../dateRange.js';
import { ConfigError, GoogleAdsApiError } from '../errors.js';
import { logger as defaultLogger, describeError } from '../logger.js';
import { CUSTOMER_QUERY, adPerformanceQuery, campaignTotalsQuery } from '../googleAds/queries.js';
import {
  aggregateToFactGrain, campaignTotalsFromApi, extractRawKeys, microsToDecimalString, normalizeRows, totals,
} from '../transform/normalize.js';
import { withTransaction } from '../db/connection.js';
import * as repo from '../db/repository.js';
import { STATUS, assertTransition, determineStatus, summarizeRejections } from './status.js';

const PREVIEW_ROWS = 10;

export async function fetchAccount(google, customerId) {
  const rows = await google.searchAll(customerId, CUSTOMER_QUERY);
  const c = rows[0]?.customer;
  if (!c?.id) throw new GoogleAdsApiError(`Unexpected Google Ads response: no customer row for ${customerId}`);
  if (c.manager) {
    throw new ConfigError(`Customer ${customerId} is a manager (MCC) account; it has no ad data of its own. `
      + 'Set GOOGLE_ADS_CUSTOMER_ID to the client account and GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager.');
  }
  return {
    id: String(c.id), name: c.descriptiveName ?? null, currencyCode: c.currencyCode ?? null,
    timeZone: c.timeZone || 'UTC', testAccount: Boolean(c.testAccount),
  };
}

/**
 * Compares per-campaign spend at ad level against campaign-level totals.
 * Campaign types without ad_group_ad rows (Performance Max, Smart, some App
 * campaigns) show up here as gaps, because core.fact_google_ads is ad-grain.
 */
export function reconcileCampaignCoverage(acceptedRecords, campaignRows) {
  const adLevel = new Map();
  for (const r of acceptedRecords) adLevel.set(r.campaign_id, (adLevel.get(r.campaign_id) ?? 0n) + r.spend_micros);
  const gaps = [];
  for (const t of campaignTotalsFromApi(campaignRows).values()) {
    const ad = adLevel.get(t.campaign_id) ?? 0n;
    const diff = t.spend_micros - ad;
    if (diff > 10_000n || diff < -10_000n) { // tolerate < 0.01 currency units of rounding
      gaps.push({
        campaign_id: t.campaign_id, campaign_name: t.campaign_name, channel_type: t.channel_type,
        campaign_level_spend: microsToDecimalString(t.spend_micros), ad_level_spend: microsToDecimalString(ad),
        unloaded_spend: microsToDecimalString(diff),
      });
    }
  }
  return gaps;
}

function buildRawRows(apiRows, apiVersion) {
  // One raw row per API result row, holding that row verbatim (not the whole
  // response), so any single row can be re-processed. Rows without a valid
  // date cannot be stored (business_date is NOT NULL); they are rejected and
  // logged instead.
  const rawIdByIndex = new Map();
  const rawRows = [];
  apiRows.forEach((row, index) => {
    const k = extractRawKeys(row);
    if (!k.businessDate) return;
    const raw_id = randomUUID();
    rawIdByIndex.set(index, raw_id);
    rawRows.push({
      raw_id, business_date: k.businessDate, customer_id: k.customerId, campaign_id: k.campaignId,
      ad_group_id: k.adGroupId, ad_id: k.adId,
      payload: { api_version: apiVersion, resource: 'ad_group_ad', row },
    });
  });
  return { rawRows, rawIdByIndex };
}

/**
 * Runs one sync. In dry-run mode nothing is written: no import_log row, no
 * raw/staging/core rows. If a database connection is supplied in dry-run, it
 * is used read-only to preview inserts vs updates.
 *
 * @returns report object (also what the CLI prints)
 */
export async function syncCustomer({
  google, db, customerId, lookbackDays = 7, start, end, days, dryRun = false,
  schema = null, now = new Date(), logger = defaultLogger,
}) {
  const report = { customerId, dryRun, status: null, importId: null, range: null, counts: {}, totals: {}, checks: [], warnings: [], rejectedSamples: [] };
  let importId = null;
  let status = STATUS.RUNNING;

  if (!dryRun) {
    // Created first, so even an auth failure leaves a record. Dates are
    // filled in once the account time zone is known.
    importId = await repo.createImportLog(db, { start: start ?? null, end: end ?? null });
    report.importId = importId;
    logger.info('import.started', { importId, customerId });
  }

  try {
    const account = await fetchAccount(google, customerId);
    report.account = account;
    const today = todayInTimeZone(account.timeZone, now);
    const range = resolveDateRange({ today, lookbackDays, start, end, days });
    report.range = range;
    if (importId) await repo.updateImportLog(db, importId, { business_date_start: range.start, business_date_end: range.end });
    logger.info('google_ads.fetch', { customerId, account: account.name, currency: account.currencyCode, timeZone: account.timeZone, ...range });

    const apiRows = await google.searchAll(customerId, adPerformanceQuery(range.start, range.end));
    const campaignRows = await google.searchAll(customerId, campaignTotalsQuery(range.start, range.end));
    report.counts.api_records_received = apiRows.length;

    const { accepted, rejected, warnings } = normalizeRows(apiRows, {
      customerId, currencyCode: account.currencyCode, range, dateBounds: schema?.dateBounds,
    });
    const records = accepted.map((a) => a.record);
    report.counts.records_accepted = accepted.length;
    report.counts.records_rejected = rejected.length;
    report.rejectedSamples = rejected.slice(0, 10);
    for (const w of warnings) report.warnings.push(`row ${w.index}: ${w.warning}`);
    for (const r of rejected) logger.warn('staging.rejected', { importId, index: r.index, keys: r.keys, reasons: r.reasons });

    const gaps = reconcileCampaignCoverage(records, campaignRows);
    report.campaignCoverageGaps = gaps;
    for (const g of gaps) {
      report.warnings.push(`campaign ${g.campaign_id} (${g.channel_type ?? 'unknown type'}) has ${g.unloaded_spend} ${account.currencyCode ?? ''} `
        + 'campaign-level spend with no ad-level rows; it is not in core.fact_google_ads');
    }
    report.totals.api_accepted = totals(records);
    const factGrain = aggregateToFactGrain(records);
    report.counts.fact_grain_rows = factGrain.size;
    report.counts.campaigns = new Set(records.map((r) => r.campaign_id)).size;

    if (dryRun) {
      if (db && schema) {
        await withTransaction(db, async (tx) => {
          const keys = [...factGrain.values()].map(({ business_date, campaign_id, ad_group_id, ad_id }) => ({ business_date, campaign_id, ad_group_id, ad_id }));
          const existing = await repo.countExistingFactKeys(tx, keys);
          const existingCampaigns = await repo.countExistingCampaigns(tx, schema.platformKey, [...new Set(records.map((r) => r.campaign_id))]);
          report.counts.would_insert_facts = keys.length - existing;
          report.counts.would_update_or_keep_facts = existing;
          report.counts.would_insert_campaigns = report.counts.campaigns - existingCampaigns;
        }, { readOnly: true });
      }
      report.preview = [...factGrain.values()].slice(0, PREVIEW_ROWS).map((f) => ({
        business_date: f.business_date, campaign_id: f.campaign_id, ad_group_id: f.ad_group_id, ad_id: f.ad_id,
        impressions: f.impressions.toString(), clicks: f.clicks.toString(), spend: microsToDecimalString(f.spend_micros),
        conversions: f.conversions, conversion_value: f.conversion_value,
      }));
      report.status = rejected.length ? 'dry-run (would be partial)' : 'dry-run (would be success)';
      return report;
    }

    // 1) Raw, committed on its own so source data survives a later failure
    //    and can be re-processed.
    const { rawRows, rawIdByIndex } = buildRawRows(apiRows, google.config.apiVersion);
    report.counts.raw_written = await withTransaction(db, (tx) => repo.insertRaw(tx, importId, rawRows));

    // 2) Staging + core + integrity checks in one transaction: either the
    //    whole window lands consistently or nothing in core changes.
    const stagingRecords = accepted.map((a) => ({ ...a.record, raw_id: rawIdByIndex.get(a.index) }));
    let checks = [];
    let validationFailed = false;
    try {
      await withTransaction(db, async (tx) => {
        report.counts.staging_written = await repo.insertStaging(tx, importId, stagingRecords);
        const camp = await repo.upsertCampaigns(tx, importId, schema.platformKey);
        report.counts.campaigns_inserted = camp.inserted;
        report.counts.campaigns_updated = camp.updated;
        report.counts.campaigns_unchanged = camp.unchanged;
        const facts = await repo.upsertFacts(tx, importId, schema.platformKey);
        report.counts.facts_inserted = facts.inserted;
        report.counts.facts_updated = facts.updated;
        report.counts.facts_unchanged = facts.unchanged;
        const v = await repo.validateLoad(tx, { importId, start: range.start, end: range.end, platformKey: schema.platformKey, customerId });
        checks = v.checks;
        report.totals.core_window = v.totals;
        if (checks.some((c) => !c.passed && c.severity === 'error')) {
          validationFailed = true;
          throw new Error('integrity checks failed');
        }
      });
    } catch (err) {
      if (!validationFailed) throw err;
    }
    report.checks = checks;
    for (const c of checks.filter((x) => !x.passed && x.severity === 'warning')) report.warnings.push(`${c.name}: ${c.detail}`);

    status = assertTransition(status, determineStatus({ rejected: rejected.length, checks }));
    const failedChecks = checks.filter((c) => !c.passed && c.severity === 'error');
    let errorMessage = null;
    if (failedChecks.length) {
      errorMessage = `Integrity checks failed; core changes rolled back (raw kept): ${failedChecks.map((c) => `${c.name}: ${c.detail}`).join('; ')}`;
      report.counts.facts_inserted = 0;
      report.counts.facts_updated = 0;
      report.counts.staging_written = 0;
    } else if (rejected.length) {
      errorMessage = `${rejected.length} of ${apiRows.length} rows rejected: ${summarizeRejections(rejected)}`;
    }
    await repo.updateImportLog(db, importId, {
      status, complete: true,
      records_received: apiRows.length,
      records_inserted: report.counts.facts_inserted ?? 0,
      records_updated: report.counts.facts_updated ?? 0,
      records_rejected: rejected.length,
      error_message: errorMessage,
    });
    report.status = status;
    report.errorMessage = errorMessage;
    logger.info('import.finished', { importId, status, counts: report.counts });
    return report;
  } catch (err) {
    report.status = STATUS.FAILED;
    report.errorMessage = describeError(err);
    if (importId) {
      try {
        assertTransition(status, STATUS.FAILED);
        await repo.updateImportLog(db, importId, {
          status: STATUS.FAILED, complete: true,
          records_received: report.counts.api_records_received ?? 0,
          records_inserted: 0, records_updated: 0,
          records_rejected: report.counts.records_rejected ?? 0,
          error_message: report.errorMessage,
        });
      } catch (logErr) {
        logger.error('import_log.update_failed', { importId, error: describeError(logErr) });
      }
    }
    logger.error('import.failed', { importId, customerId, error: report.errorMessage });
    err.report = report;
    throw err;
  }
}
