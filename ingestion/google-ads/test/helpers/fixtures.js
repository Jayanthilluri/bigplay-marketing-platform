// Builders for Google Ads REST (proto3 JSON) rows: camelCase fields, int64
// values as strings, zero-valued fields omitted. Pass null for a metric to
// omit it, as the API does for zero values.

export const CUSTOMER_ID = '1234567890';

export function adRow({
  date = '2026-10-01', campaignId = '111', campaignName = 'Fall Bowling Promo', campaignStatus = 'ENABLED',
  channel = 'SEARCH', adGroupId = '222', adGroupName = 'Leagues', adId = '333', adName = 'RSA 1',
  device = 'MOBILE', network = 'SEARCH', impressions = '1000', clicks = '50', costMicros = '12345678',
  conversions = 3, conversionsValue = 150.5, customerId = CUSTOMER_ID, currency = 'USD', extraMetrics = {},
} = {}) {
  const metrics = { ...extraMetrics };
  if (impressions !== null) metrics.impressions = impressions;
  if (clicks !== null) metrics.clicks = clicks;
  if (costMicros !== null) metrics.costMicros = costMicros;
  if (conversions !== null) metrics.conversions = conversions;
  if (conversionsValue !== null) metrics.conversionsValue = conversionsValue;
  return {
    customer: { resourceName: `customers/${customerId}`, id: customerId, currencyCode: currency },
    campaign: { resourceName: `customers/${customerId}/campaigns/${campaignId}`, id: campaignId, name: campaignName, status: campaignStatus, advertisingChannelType: channel },
    adGroup: { resourceName: `customers/${customerId}/adGroups/${adGroupId}`, id: adGroupId, name: adGroupName },
    adGroupAd: { resourceName: `customers/${customerId}/adGroupAds/${adGroupId}~${adId}`, status: 'ENABLED', ad: { resourceName: `customers/${customerId}/ads/${adId}`, id: adId, name: adName } },
    segments: { date, device, adNetworkType: network },
    metrics,
  };
}

export function campaignRow({ date = '2026-10-01', campaignId = '111', campaignName = 'Fall Bowling Promo', channel = 'SEARCH', costMicros = '0', impressions = '0' } = {}) {
  return {
    campaign: { id: campaignId, name: campaignName, advertisingChannelType: channel },
    segments: { date },
    metrics: { costMicros, impressions },
  };
}

export const ACCOUNT_ROW = {
  customer: { id: CUSTOMER_ID, descriptiveName: 'Big Play Entertainment', currencyCode: 'USD', timeZone: 'America/New_York', manager: false, testAccount: false },
};

/** Campaign-level totals matching a set of ad rows (so no coverage gap). */
export function campaignRowsFor(adRows) {
  const by = new Map();
  for (const r of adRows) {
    const k = `${r.campaign.id}|${r.segments.date}`;
    const t = by.get(k) ?? { campaignId: r.campaign.id, campaignName: r.campaign.name, channel: r.campaign.advertisingChannelType, date: r.segments.date, cost: 0n, imp: 0n };
    t.cost += BigInt(r.metrics.costMicros ?? 0);
    t.imp += BigInt(r.metrics.impressions ?? 0);
    by.set(k, t);
  }
  return [...by.values()].map((t) => campaignRow({ ...t, costMicros: t.cost.toString(), impressions: t.imp.toString() }));
}

/**
 * In-memory stand-in for GoogleAdsClient. `rows` may be replaced between
 * runs to simulate Google restating data.
 */
export class FakeGoogleAds {
  constructor({ rows = [], campaignRows, account = ACCOUNT_ROW, failWith } = {}) {
    this.rows = rows;
    this.campaignRows = campaignRows;
    this.account = account;
    this.failWith = failWith;
    this.config = { apiVersion: 'v25' };
    this.queries = [];
  }

  async searchAll(_customerId, query) {
    this.queries.push(query);
    if (this.failWith && !query.includes('FROM customer')) throw this.failWith;
    if (query.includes('FROM customer')) return [this.account];
    if (query.includes('FROM ad_group_ad')) return this.rows;
    if (query.includes('FROM campaign')) return this.campaignRows ?? campaignRowsFor(this.rows);
    throw new Error(`unexpected query ${query}`);
  }
}
