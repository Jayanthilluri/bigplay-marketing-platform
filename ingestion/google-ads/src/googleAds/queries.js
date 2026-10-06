// GAQL queries. Dates are validated YYYY-MM-DD strings before they get here,
// so interpolation cannot inject GAQL.

import { isValidIsoDate } from '../dateRange.js';

function assertDates(start, end) {
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) throw new Error(`Invalid GAQL date range ${start}..${end}`);
}

export const CUSTOMER_QUERY = `
SELECT customer.id, customer.descriptive_name, customer.currency_code,
       customer.time_zone, customer.manager, customer.test_account
FROM customer
LIMIT 1`.trim();

/**
 * Daily ad-level performance, segmented by device and network. Raw and
 * staging keep this finer grain; core.fact_google_ads stores the
 * date/campaign/ad group/ad grain, so the fact load sums device/network.
 */
export function adPerformanceQuery(start, end) {
  assertDates(start, end);
  return `
SELECT customer.id, customer.currency_code,
       campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
       ad_group.id, ad_group.name,
       ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status,
       segments.date, segments.device, segments.ad_network_type,
       metrics.impressions, metrics.clicks, metrics.cost_micros,
       metrics.conversions, metrics.conversions_value,
       metrics.ctr, metrics.average_cpc, metrics.cost_per_conversion
FROM ad_group_ad
WHERE segments.date BETWEEN '${start}' AND '${end}'`.trim();
}

/**
 * Campaign-level totals for reconciliation. Some campaign types (Performance
 * Max, Smart, some App campaigns) have no ad_group_ad rows, so their spend is
 * invisible to the ad-level query; comparing against this exposes the gap.
 */
export function campaignTotalsQuery(start, end) {
  assertDates(start, end);
  return `
SELECT campaign.id, campaign.name, campaign.advertising_channel_type, segments.date,
       metrics.impressions, metrics.clicks, metrics.cost_micros,
       metrics.conversions, metrics.conversions_value
FROM campaign
WHERE segments.date BETWEEN '${start}' AND '${end}'`.trim();
}
