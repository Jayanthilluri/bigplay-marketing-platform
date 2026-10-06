import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateToFactGrain, microsToDecimalString, normalizeName, normalizeRow, normalizeRows, parseCount, parseDecimal, totals,
} from '../../src/transform/normalize.js';
import { reconcileCampaignCoverage } from '../../src/pipeline/sync.js';
import { CUSTOMER_ID, adRow, campaignRow } from '../helpers/fixtures.js';

const ctx = { customerId: CUSTOMER_ID, currencyCode: 'USD', range: { start: '2026-09-29', end: '2026-10-06' }, dateBounds: { min: '2024-01-01', max: '2030-12-31' } };

test('normalizes a valid REST row', () => {
  const r = normalizeRow(adRow({ campaignName: '  Fall\tPromo  ' }), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.record, spend_micros: undefined }, {
    business_date: '2026-10-01', customer_id: CUSTOMER_ID, campaign_id: '111', campaign_name: 'Fall Promo',
    campaign_status: 'ENABLED', campaign_channel_type: 'SEARCH', ad_group_id: '222', ad_group_name: 'Leagues',
    ad_id: '333', ad_name: 'RSA 1', impressions: '1000', clicks: '50', spend: '12.345678', spend_micros: undefined,
    conversions: 3, conversion_value: 150.5, device: 'MOBILE', network: 'SEARCH',
  });
});

test('omitted metrics mean zero (proto3 JSON omits defaults)', () => {
  const r = normalizeRow(adRow({ impressions: null, clicks: null, costMicros: null, conversions: null, conversionsValue: null }), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.record.impressions, '0');
  assert.equal(r.record.spend, '0');
  assert.equal(r.record.conversions, 0);
});

test('non-numeric metrics are rejected, never coerced to 0', () => {
  for (const [field, value] of [['impressions', 'abc'], ['clicks', '1.5'], ['costMicros', '12.3'], ['conversions', 'NaN'], ['conversionsValue', {}]]) {
    const row = adRow();
    row.metrics[field] = value;
    const r = normalizeRow(row, ctx);
    assert.equal(r.ok, false, field);
    assert.match(r.reasons.join(), /not (an integer|numeric|finite)/, field);
  }
});

test('negative spend/impressions are rejected; negative conversions are flagged only', () => {
  assert.match(normalizeRow(adRow({ costMicros: '-5000000' }), ctx).reasons.join(), /negative spend/);
  assert.match(normalizeRow(adRow({ impressions: '-1' }), ctx).reasons.join(), /negative/);
  const r = normalizeRow(adRow({ conversions: -1 }), ctx);
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /negative conversions/);
});

test('missing or malformed identifiers are rejected', () => {
  const cases = [
    [(row) => { delete row.campaign.id; }, /campaign\.id/],
    [(row) => { row.adGroup.id = ''; }, /ad_group\.id/],
    [(row) => { row.adGroupAd.ad.id = 'abc'; }, /ad_group_ad\.ad\.id/],
    [(row) => { delete row.segments.date; }, /missing segments\.date/],
    [(row) => { row.segments.date = '2026-02-30'; }, /invalid segments\.date/],
    [(row) => { row.customer.id = '999'; }, /customer\.id/],
  ];
  for (const [mutate, pattern] of cases) {
    const row = adRow();
    mutate(row);
    const r = normalizeRow(row, ctx);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(), pattern);
  }
});

test('dates outside the requested range or dim_date are rejected', () => {
  assert.match(normalizeRow(adRow({ date: '2026-09-01' }), ctx).reasons.join(), /outside requested range/);
  const r = normalizeRow(adRow({ date: '2031-01-01' }), { ...ctx, range: { start: '2030-12-01', end: '2031-01-05' } });
  assert.match(r.reasons.join(), /not covered by core\.dim_date/);
});

test('currency mismatch is rejected', () => {
  assert.match(normalizeRow(adRow({ currency: 'EUR' }), ctx).reasons.join(), /currency EUR/);
});

test('numeric parsing helpers', () => {
  assert.equal(parseCount('9007199254740993', 'x'), 9007199254740993n); // beyond Number precision, kept exact
  assert.equal(parseCount(42, 'x'), 42n);
  assert.throws(() => parseCount(4.2, 'x'));
  assert.equal(parseDecimal('1.5e2', 'x'), 150);
  assert.equal(parseDecimal(undefined, 'x'), 0);
  assert.throws(() => parseDecimal(Infinity, 'x'));
  assert.throws(() => parseDecimal('1,000', 'x'));
  assert.equal(microsToDecimalString(1_000_000n), '1');
  assert.equal(microsToDecimalString(1n), '0.000001');
  assert.equal(microsToDecimalString(123_456_789_012n), '123456.789012');
  assert.equal(normalizeName('   '), null);
});

test('duplicate segment rows in one response are rejected, not double counted', () => {
  const rows = [adRow(), adRow(), adRow({ device: 'DESKTOP' })];
  const { accepted, rejected } = normalizeRows(rows, ctx);
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 1);
  assert.match(rejected[0].reasons[0], /duplicate segment row/);
});

test('device/network segments aggregate to the fact grain exactly', () => {
  const rows = [
    adRow({ device: 'MOBILE', costMicros: '100000', impressions: '10', conversions: 0.1 }),
    adRow({ device: 'DESKTOP', costMicros: '200000', impressions: '20', conversions: 0.2 }),
    adRow({ device: 'MOBILE', network: 'SEARCH_PARTNERS', costMicros: '300000', impressions: '30' }),
    adRow({ adId: '444', costMicros: '1' }),
  ];
  const { accepted } = normalizeRows(rows, ctx);
  const grain = aggregateToFactGrain(accepted.map((a) => a.record));
  assert.equal(grain.size, 2);
  const g = grain.get('2026-10-01|111|222|333');
  assert.equal(g.impressions, 60n);
  assert.equal(g.spend_micros, 600000n);
  const t = totals(accepted.map((a) => a.record));
  assert.equal(t.spend, '0.600001');
  assert.equal(t.impressions, '1060');
});

test('campaign coverage gap is reported for campaigns without ad-level rows (e.g. PMax)', () => {
  const { accepted } = normalizeRows([adRow({ costMicros: '5000000' })], ctx);
  const gaps = reconcileCampaignCoverage(accepted.map((a) => a.record), [
    campaignRow({ campaignId: '111', costMicros: '5000000' }),
    campaignRow({ campaignId: '999', channel: 'PERFORMANCE_MAX', costMicros: '7500000' }),
  ]);
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0].campaign_id, gaps[0].channel_type, gaps[0].unloaded_spend], ['999', 'PERFORMANCE_MAX', '7.5']);
});
