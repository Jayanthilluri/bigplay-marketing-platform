-- TEST FIXTURE ONLY — never apply this to Supabase.
--
-- A replica of the live Big Play Supabase schema (raw / staging / core /
-- admin / analytics) as inspected on 2026-10-06 from project
-- yauypqfvrvmwqptwirao via information_schema / pg_constraint /
-- information_schema.views. Integration tests load it into a throwaway local
-- Postgres so the pipeline's SQL runs against the same tables, constraints
-- and analytics views that production has.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA raw;
CREATE SCHEMA staging;
CREATE SCHEMA core;
CREATE SCHEMA analytics;
CREATE SCHEMA admin;

CREATE TABLE admin.import_log (
  import_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_type text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  business_date_start date,
  business_date_end date,
  records_received integer DEFAULT 0,
  records_inserted integer DEFAULT 0,
  records_updated integer DEFAULT 0,
  records_rejected integer DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raw.google_ads_daily (
  raw_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid REFERENCES admin.import_log(import_id),
  business_date date NOT NULL,
  customer_id text,
  campaign_id text,
  ad_group_id text,
  ad_id text,
  payload jsonb NOT NULL,
  received_at timestamptz DEFAULT now()
);

CREATE TABLE raw.meta_ads_daily (
  raw_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid REFERENCES admin.import_log(import_id),
  business_date date NOT NULL,
  account_id text,
  campaign_id text,
  ad_set_id text,
  ad_id text,
  payload jsonb NOT NULL,
  received_at timestamptz DEFAULT now()
);

CREATE TABLE staging.google_ads_daily (
  staging_id bigserial PRIMARY KEY,
  raw_id uuid,
  import_id uuid,
  business_date date NOT NULL,
  customer_id text,
  campaign_id text,
  campaign_name text,
  ad_group_id text,
  ad_group_name text,
  ad_id text,
  ad_name text,
  impressions bigint DEFAULT 0,
  clicks bigint DEFAULT 0,
  spend numeric DEFAULT 0,
  conversions numeric DEFAULT 0,
  conversion_value numeric DEFAULT 0,
  device text,
  network text,
  processed_at timestamptz DEFAULT now()
);
CREATE INDEX idx_staging_google_campaign ON staging.google_ads_daily (campaign_id);
CREATE INDEX idx_staging_google_date ON staging.google_ads_daily (business_date);

CREATE TABLE core.dim_date (
  date_key integer PRIMARY KEY,
  full_date date NOT NULL UNIQUE,
  year integer,
  quarter integer,
  month integer,
  month_name text,
  week integer,
  day_of_week integer,
  day_name text
);

CREATE TABLE core.dim_platform (
  platform_key serial PRIMARY KEY,
  platform_code text NOT NULL UNIQUE,
  platform_name text NOT NULL
);

CREATE TABLE core.dim_campaign (
  campaign_key bigserial PRIMARY KEY,
  platform_key integer REFERENCES core.dim_platform(platform_key),
  source_campaign_id text NOT NULL,
  campaign_name text,
  objective text,
  status text,
  first_seen_date date,
  last_seen_date date,
  UNIQUE (platform_key, source_campaign_id)
);

CREATE TABLE core.fact_google_ads (
  google_ads_key bigserial PRIMARY KEY,
  date_key integer REFERENCES core.dim_date(date_key),
  campaign_key bigint REFERENCES core.dim_campaign(campaign_key),
  source_campaign_id text,
  source_ad_group_id text,
  source_ad_id text,
  impressions bigint DEFAULT 0,
  clicks bigint DEFAULT 0,
  spend numeric DEFAULT 0,
  conversions numeric DEFAULT 0,
  conversion_value numeric DEFAULT 0,
  imported_at timestamptz DEFAULT now(),
  CONSTRAINT fact_google_ads_date_key_source_campaign_id_source_ad_group_key
    UNIQUE (date_key, source_campaign_id, source_ad_group_id, source_ad_id)
);

CREATE TABLE core.fact_meta_ads (
  meta_ads_key bigserial PRIMARY KEY,
  date_key integer REFERENCES core.dim_date(date_key),
  campaign_key bigint REFERENCES core.dim_campaign(campaign_key),
  source_campaign_id text,
  source_ad_set_id text,
  source_ad_id text,
  source_creative_id text,
  impressions bigint DEFAULT 0,
  reach bigint DEFAULT 0,
  clicks bigint DEFAULT 0,
  link_clicks bigint DEFAULT 0,
  spend numeric DEFAULT 0,
  conversions numeric DEFAULT 0,
  conversion_value numeric DEFAULT 0,
  imported_at timestamptz DEFAULT now()
);

-- Seed data matching production.
INSERT INTO core.dim_platform (platform_key, platform_code, platform_name)
VALUES (1, 'google', 'Google Ads'), (2, 'meta', 'Meta Ads');
SELECT setval('core.dim_platform_platform_key_seq', 2);

INSERT INTO core.dim_date
SELECT to_char(d, 'YYYYMMDD')::int, d::date,
       extract(year FROM d)::int, extract(quarter FROM d)::int,
       extract(month FROM d)::int, trim(to_char(d, 'Month')),
       extract(week FROM d)::int, extract(isodow FROM d)::int,
       trim(to_char(d, 'Day'))
FROM generate_series('2024-01-01'::date, '2030-12-31'::date, interval '1 day') d;

-- Analytics views, verbatim from production.
CREATE VIEW analytics.google_campaign_performance AS
 SELECT d.full_date AS date,
    p.platform_code AS platform,
    g.source_campaign_id AS campaign_id,
    c.campaign_name,
    sum(g.impressions) AS impressions,
    sum(g.clicks) AS clicks,
    sum(g.spend) AS spend,
    sum(g.conversions) AS conversions,
    sum(g.conversion_value) AS conversion_value,
        CASE WHEN (sum(g.impressions) > (0)::numeric) THEN (sum(g.clicks) / sum(g.impressions)) ELSE (0)::numeric END AS ctr,
        CASE WHEN (sum(g.clicks) > (0)::numeric) THEN (sum(g.spend) / sum(g.clicks)) ELSE (0)::numeric END AS cpc,
        CASE WHEN (sum(g.impressions) > (0)::numeric) THEN ((sum(g.spend) / sum(g.impressions)) * (1000)::numeric) ELSE (0)::numeric END AS cpm,
        CASE WHEN (sum(g.conversions) > (0)::numeric) THEN (sum(g.spend) / sum(g.conversions)) ELSE (0)::numeric END AS cpa,
        CASE WHEN (sum(g.spend) > (0)::numeric) THEN (sum(g.conversion_value) / sum(g.spend)) ELSE (0)::numeric END AS roas
   FROM (((core.fact_google_ads g
     JOIN core.dim_date d ON ((g.date_key = d.date_key)))
     JOIN core.dim_campaign c ON ((g.campaign_key = c.campaign_key)))
     JOIN core.dim_platform p ON ((c.platform_key = p.platform_key)))
  GROUP BY d.full_date, p.platform_code, g.source_campaign_id, c.campaign_name;

CREATE VIEW analytics.meta_campaign_performance AS
 SELECT d.full_date AS date,
    p.platform_code AS platform,
    m.source_campaign_id AS campaign_id,
    c.campaign_name,
    sum(m.impressions) AS impressions,
    sum(m.clicks) AS clicks,
    sum(m.spend) AS spend,
    sum(m.conversions) AS conversions,
    sum(m.conversion_value) AS conversion_value,
        CASE WHEN (sum(m.impressions) > (0)::numeric) THEN (sum(m.clicks) / sum(m.impressions)) ELSE (0)::numeric END AS ctr,
        CASE WHEN (sum(m.clicks) > (0)::numeric) THEN (sum(m.spend) / sum(m.clicks)) ELSE (0)::numeric END AS cpc,
        CASE WHEN (sum(m.impressions) > (0)::numeric) THEN ((sum(m.spend) / sum(m.impressions)) * (1000)::numeric) ELSE (0)::numeric END AS cpm,
        CASE WHEN (sum(m.conversions) > (0)::numeric) THEN (sum(m.spend) / sum(m.conversions)) ELSE (0)::numeric END AS cpa,
        CASE WHEN (sum(m.spend) > (0)::numeric) THEN (sum(m.conversion_value) / sum(m.spend)) ELSE (0)::numeric END AS roas
   FROM (((core.fact_meta_ads m
     JOIN core.dim_date d ON ((m.date_key = d.date_key)))
     JOIN core.dim_campaign c ON ((m.campaign_key = c.campaign_key)))
     JOIN core.dim_platform p ON ((c.platform_key = p.platform_key)))
  GROUP BY d.full_date, p.platform_code, m.source_campaign_id, c.campaign_name;

CREATE VIEW analytics.daily_marketing_performance AS
 SELECT date, platform, campaign_id, campaign_name, impressions, clicks, spend,
        conversions, conversion_value, ctr, cpc, cpm, cpa, roas
   FROM analytics.google_campaign_performance
UNION ALL
 SELECT date, platform, campaign_id, campaign_name, impressions, clicks, spend,
        conversions, conversion_value, ctr, cpc, cpm, cpa, roas
   FROM analytics.meta_campaign_performance;

CREATE VIEW analytics.platform_comparison AS
 SELECT date, platform,
    sum(impressions) AS impressions,
    sum(clicks) AS clicks,
    sum(spend) AS spend,
    sum(conversions) AS conversions,
    sum(conversion_value) AS conversion_value,
        CASE WHEN (sum(impressions) > (0)::numeric) THEN (sum(clicks) / sum(impressions)) ELSE (0)::numeric END AS ctr,
        CASE WHEN (sum(clicks) > (0)::numeric) THEN (sum(spend) / sum(clicks)) ELSE (0)::numeric END AS cpc,
        CASE WHEN (sum(conversions) > (0)::numeric) THEN (sum(spend) / sum(conversions)) ELSE (0)::numeric END AS cpa,
        CASE WHEN (sum(spend) > (0)::numeric) THEN (sum(conversion_value) / sum(spend)) ELSE (0)::numeric END AS roas
   FROM analytics.daily_marketing_performance
  GROUP BY date, platform;

CREATE VIEW analytics.data_freshness AS
 SELECT 'Google Ads'::text AS source,
    max(business_date) AS data_through_date,
    max(received_at) AS last_received_at,
    count(*) AS raw_record_count
   FROM raw.google_ads_daily
UNION ALL
 SELECT 'Meta Ads'::text AS source,
    max(business_date) AS data_through_date,
    max(received_at) AS last_received_at,
    count(*) AS raw_record_count
   FROM raw.meta_ads_daily;
