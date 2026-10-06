// Raw Google Ads REST row -> staging record.
//
// Rules:
//  * Required identifiers (date, customer, campaign, ad group, ad) must be
//    present and well-formed, otherwise the row is rejected with a reason.
//  * Metrics must be numeric. A *missing* metric is 0: the REST API encodes
//    responses as proto3 JSON, which omits fields equal to their default (0),
//    so absence is Google's encoding of zero, not missing data. A metric that
//    is present but non-numeric is rejected, never coerced to 0.
//  * Spend is cost_micros / 1,000,000 in the account currency, computed with
//    integer arithmetic so no floating-point error reaches the database.
//  * Negative impressions/clicks/spend are rejected (Google Ads performance
//    reports do not emit negative cost). Negative conversions can be a
//    legitimate restatement, so they are kept but flagged as a warning.

import { isValidIsoDate } from '../dateRange.js';

const ID = /^\d+$/;
const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const UNSET_ENUMS = new Set(['UNSPECIFIED', 'UNKNOWN', '']);

export function normalizeId(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return ID.test(s) ? s : null;
}

export function normalizeName(value) {
  if (value === undefined || value === null) return null;
  // Strip control characters and surrounding whitespace; keep the name as
  // advertisers typed it otherwise so it matches the Google Ads UI.
  // eslint-disable-next-line no-control-regex
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s === '' ? null : s;
}

export function normalizeEnum(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toUpperCase();
  return UNSET_ENUMS.has(s) ? null : s;
}

/** int64 metric (proto3 JSON encodes int64 as a string). Returns BigInt or throws. */
export function parseCount(value, field) {
  if (value === undefined || value === null) return 0n;
  const s = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : 'x') : String(value).trim();
  if (!INTEGER.test(s)) throw new RangeError(`${field} is not an integer: ${JSON.stringify(value)}`);
  const n = BigInt(s);
  if (n < 0n) throw new RangeError(`${field} is negative: ${s}`);
  return n;
}

/** double metric. Returns a finite Number or throws. */
export function parseDecimal(value, field) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${field} is not finite: ${value}`);
    return value;
  }
  const s = String(value).trim();
  if (!DECIMAL.test(s)) throw new RangeError(`${field} is not numeric: ${JSON.stringify(value)}`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new RangeError(`${field} is not finite: ${s}`);
  return n;
}

/** Exact decimal string for a micros amount, e.g. 1234567n -> "1.234567". */
export function microsToDecimalString(micros) {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Best-effort identifiers for the raw row; raw keeps everything, even rows staging rejects. */
export function extractRawKeys(row) {
  return {
    businessDate: isValidIsoDate(row?.segments?.date) ? row.segments.date : null,
    customerId: normalizeId(row?.customer?.id),
    campaignId: normalizeId(row?.campaign?.id),
    adGroupId: normalizeId(row?.adGroup?.id),
    adId: normalizeId(row?.adGroupAd?.ad?.id),
  };
}

/**
 * @param row  one element of a googleAds:search `results` array
 * @param ctx  { customerId, currencyCode, range: {start,end}, dateBounds: {min,max} }
 * @returns {{ ok: true, record, warnings: string[] } | { ok: false, reasons: string[] }}
 */
export function normalizeRow(row, ctx) {
  const reasons = [];
  const warnings = [];
  if (!row || typeof row !== 'object') return { ok: false, reasons: ['row is not an object'] };

  const keys = extractRawKeys(row);
  const date = row.segments?.date;
  if (!date) reasons.push('missing segments.date');
  else if (!keys.businessDate) reasons.push(`invalid segments.date ${JSON.stringify(date)}`);
  else {
    if (ctx.range && (date < ctx.range.start || date > ctx.range.end)) {
      reasons.push(`segments.date ${date} outside requested range ${ctx.range.start}..${ctx.range.end}`);
    }
    if (ctx.dateBounds && (date < ctx.dateBounds.min || date > ctx.dateBounds.max)) {
      reasons.push(`segments.date ${date} not covered by core.dim_date (${ctx.dateBounds.min}..${ctx.dateBounds.max})`);
    }
  }

  if (!keys.customerId) reasons.push('missing or invalid customer.id');
  else if (ctx.customerId && keys.customerId !== ctx.customerId) reasons.push(`customer.id ${keys.customerId} does not match requested ${ctx.customerId}`);
  if (!keys.campaignId) reasons.push('missing or invalid campaign.id');
  if (!keys.adGroupId) reasons.push('missing or invalid ad_group.id');
  if (!keys.adId) reasons.push('missing or invalid ad_group_ad.ad.id');

  const rowCurrency = row.customer?.currencyCode;
  if (ctx.currencyCode && rowCurrency && rowCurrency !== ctx.currencyCode) {
    reasons.push(`currency ${rowCurrency} differs from account currency ${ctx.currencyCode}`);
  }

  const m = row.metrics ?? {};
  let impressions, clicks, costMicros, conversions, conversionValue;
  for (const [fn, assign] of [
    [() => parseCount(m.impressions, 'impressions'), (v) => { impressions = v; }],
    [() => parseCount(m.clicks, 'clicks'), (v) => { clicks = v; }],
    [() => {
      const s = m.costMicros === undefined || m.costMicros === null ? '0' : String(m.costMicros).trim();
      if (!INTEGER.test(s)) throw new RangeError(`cost_micros is not an integer: ${JSON.stringify(m.costMicros)}`);
      const v = BigInt(s);
      if (v < 0n) throw new RangeError(`negative spend (cost_micros ${s})`);
      return v;
    }, (v) => { costMicros = v; }],
    [() => parseDecimal(m.conversions, 'conversions'), (v) => { conversions = v; }],
    [() => parseDecimal(m.conversionsValue, 'conversion_value'), (v) => { conversionValue = v; }],
  ]) {
    try { assign(fn()); } catch (e) { reasons.push(e.message); }
  }

  if (reasons.length) return { ok: false, reasons };
  if (conversions < 0) warnings.push(`negative conversions ${conversions} (restatement)`);
  if (conversionValue < 0) warnings.push(`negative conversion_value ${conversionValue} (restatement)`);

  return {
    ok: true,
    warnings,
    record: {
      business_date: keys.businessDate,
      customer_id: keys.customerId,
      campaign_id: keys.campaignId,
      campaign_name: normalizeName(row.campaign?.name),
      campaign_status: normalizeEnum(row.campaign?.status),
      campaign_channel_type: normalizeEnum(row.campaign?.advertisingChannelType),
      ad_group_id: keys.adGroupId,
      ad_group_name: normalizeName(row.adGroup?.name),
      ad_id: keys.adId,
      ad_name: normalizeName(row.adGroupAd?.ad?.name),
      impressions: impressions.toString(),
      clicks: clicks.toString(),
      spend: microsToDecimalString(costMicros),
      spend_micros: costMicros,
      conversions,
      conversion_value: conversionValue,
      device: normalizeEnum(row.segments?.device),
      network: normalizeEnum(row.segments?.adNetworkType),
    },
  };
}

export function segmentKey(r) {
  return [r.business_date, r.campaign_id, r.ad_group_id, r.ad_id, r.device ?? '', r.network ?? ''].join('|');
}

export function factKey(r) {
  return [r.business_date, r.campaign_id, r.ad_group_id, r.ad_id].join('|');
}

/**
 * Normalizes all API rows. Each input row gets exactly one outcome; rows that
 * repeat an already-seen segment key (same date/ad/device/network) are
 * rejected as duplicates so a pagination glitch can never double-count.
 */
export function normalizeRows(rows, ctx) {
  const accepted = [];
  const rejected = [];
  const warnings = [];
  const seen = new Map();
  rows.forEach((row, index) => {
    const result = normalizeRow(row, ctx);
    if (!result.ok) {
      rejected.push({ index, reasons: result.reasons, keys: extractRawKeys(row) });
      return;
    }
    const key = segmentKey(result.record);
    if (seen.has(key)) {
      rejected.push({ index, reasons: [`duplicate segment row in API response (first seen at row ${seen.get(key)})`], keys: extractRawKeys(row) });
      return;
    }
    seen.set(key, index);
    for (const w of result.warnings) warnings.push({ index, warning: w });
    accepted.push({ index, record: result.record });
  });
  return { accepted, rejected, warnings };
}

/** Sums staging records to the core fact grain (date, campaign, ad group, ad). */
export function aggregateToFactGrain(records) {
  const out = new Map();
  for (const r of records) {
    const key = factKey(r);
    const agg = out.get(key) ?? {
      business_date: r.business_date, campaign_id: r.campaign_id, ad_group_id: r.ad_group_id, ad_id: r.ad_id,
      impressions: 0n, clicks: 0n, spend_micros: 0n, conversions: 0, conversion_value: 0,
    };
    agg.impressions += BigInt(r.impressions);
    agg.clicks += BigInt(r.clicks);
    agg.spend_micros += r.spend_micros;
    agg.conversions += r.conversions;
    agg.conversion_value += r.conversion_value;
    out.set(key, agg);
  }
  return out;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function totals(records) {
  let impressions = 0n, clicks = 0n, spendMicros = 0n, conversions = 0, conversionValue = 0;
  for (const r of records) {
    impressions += BigInt(r.impressions);
    clicks += BigInt(r.clicks);
    spendMicros += BigInt(r.spend_micros);
    conversions += Number(r.conversions);
    conversionValue += Number(r.conversion_value);
  }
  return {
    impressions: impressions.toString(),
    clicks: clicks.toString(),
    spend: microsToDecimalString(spendMicros),
    conversions: round6(conversions),
    conversion_value: round6(conversionValue),
  };
}

/** Campaign-level API totals, summed per campaign, for reconciliation. */
export function campaignTotalsFromApi(rows) {
  const out = new Map();
  for (const row of rows) {
    const id = normalizeId(row?.campaign?.id);
    if (!id) continue;
    const t = out.get(id) ?? {
      campaign_id: id, campaign_name: normalizeName(row.campaign?.name),
      channel_type: normalizeEnum(row.campaign?.advertisingChannelType), spend_micros: 0n, impressions: 0n,
    };
    try {
      t.spend_micros += BigInt(String(row.metrics?.costMicros ?? '0'));
      t.impressions += BigInt(String(row.metrics?.impressions ?? '0'));
    } catch { /* malformed totals rows only weaken the reconciliation, they do not load */ }
    out.set(id, t);
  }
  return out;
}
