# Google Ads Ingestion Pipeline

Server-side job that pulls daily Google Ads performance into the existing
Supabase warehouse (`raw` → `staging` → `core` → `analytics`). Code lives in
[`ingestion/google-ads/`](../ingestion/google-ads/).

It builds on the existing schema only. It makes **no DDL changes**: no new
tables, columns, constraints or views, and the analytics views are untouched.

## Architecture

```
                  ┌──────────────────────────────┐
                  │  Google Ads API (REST, v25)  │
                  │  OAuth2 refresh token        │
                  └──────────────┬───────────────┘
        googleAds:search, paginated; retries on 429 / 5xx / network
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│ ingestion/google-ads  (Node, server-side only)                          │
│                                                                         │
│  1. admin.import_log          INSERT status='running'                   │
│  2. raw.google_ads_daily      1 row per API row, verbatim JSONB payload │
│                               (own transaction: always kept)            │
│  3. normalize + validate      reject bad IDs / non-numeric metrics      │
│  ┌─ single transaction ───────────────────────────────────────────────┐ │
│  │ 4. staging.google_ads_daily  typed rows, device + network kept     │ │
│  │ 5. core.dim_campaign         UPSERT (platform_key, source_id)      │ │
│  │ 6. core.fact_google_ads      UPSERT (date, campaign, ad group, ad) │ │
│  │ 7. integrity checks          any failure => ROLLBACK core          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  8. admin.import_log          UPDATE success | partial | failed         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
         analytics.google_campaign_performance, daily_marketing_performance,
         platform_comparison, data_freshness   (existing views, unchanged)
                                 │
                                 ▼
                         Dashboard (later)
```

### Grain

| Layer | Grain | Notes |
| --- | --- | --- |
| `raw.google_ads_daily` | date × ad × device × network, per import | Verbatim API row in `payload.row`; append-only history |
| `staging.google_ads_daily` | same as raw, per import | Typed and validated; `device`, `network` kept |
| `core.fact_google_ads` | date × campaign × ad group × ad | Device/network summed; one row per logical key, ever |
| `core.dim_campaign` | platform × campaign | `objective` = Google `advertising_channel_type`, `status` = campaign status |

## 1. Google Ads API setup

1. **Developer token.** In a Google Ads *manager* account: Tools → API Center.
   A new token starts at *Test* access, which only works with test accounts.
   Apply for **Basic** access to read the real Big Play account.
2. **OAuth client.** In Google Cloud Console: enable the *Google Ads API*,
   then create an OAuth client ID (type *Desktop app* is simplest). This gives
   `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET`.
3. **Refresh token.** Run an OAuth consent flow once, signed in as a Google
   user with access to the ad account, with scope
   `https://www.googleapis.com/auth/adwords`. Google's
   [OAuth Playground](https://developers.google.com/oauthplayground) works:
   gear icon → "Use your own OAuth credentials" → scope above → exchange the
   code → copy the refresh token.
   *If the Cloud project's OAuth consent screen is in "Testing" mode, refresh
   tokens expire after 7 days. Publish it to "In production" for a durable token.*
4. **Customer ID.** The 10-digit ID of the client account that runs the ads
   (top right in Google Ads). If you reach it through a manager account, also
   set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the manager ID.

Google publishes no official Node.js client library. The job uses Google's
official **REST interface** directly (`googleads.googleapis.com`), with no
third-party Google Ads wrapper.

## 2. Required credentials

| Secret | Where it comes from |
| --- | --- |
| `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` | Google Cloud OAuth client |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API Center (Basic access) |
| `GOOGLE_ADS_REFRESH_TOKEN` | One-time OAuth consent (step 3 above) |
| `SUPABASE_DB_URL` | Supabase → Connect → **Session pooler** or **Direct** URI (includes the DB password) |

### Database access: why `SUPABASE_DB_URL` and not the service-role key

Inspecting the live database showed that `raw`, `staging`, `core`, `admin` and
`analytics` grant no privileges to `service_role` (or `anon`/`authenticated`),
and these schemas aren't exposed to the Supabase Data API. So
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (supabase-js / PostgREST) can't
read or write them as configured.

Making that work would need a permissions change (`GRANT USAGE …` to
`service_role` and adding the schemas to the exposed-schema list). That is a
structural change requiring approval, so it was **not** made. The job connects
over Postgres instead. This also gives it real transactions (all-or-nothing
loads), exact insert/update counts from `ON CONFLICT … RETURNING`, and no
row-count limits. The connection string is a server-side secret, the same as
the service-role key.

## 3. Environment variables

See [`ingestion/google-ads/.env.example`](../ingestion/google-ads/.env.example).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | yes | – | OAuth client |
| `GOOGLE_ADS_CLIENT_SECRET` | yes | – | OAuth client secret |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | yes | – | API developer token |
| `GOOGLE_ADS_REFRESH_TOKEN` | yes | – | OAuth refresh token |
| `GOOGLE_ADS_CUSTOMER_ID` | yes | – | Client account ID(s), comma-separated |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | no | – | Manager account ID when accessing via MCC |
| `GOOGLE_ADS_LOOKBACK_DAYS` | no | `7` | Recurring window: today−N … today |
| `GOOGLE_ADS_BACKFILL_CHUNK_DAYS` | no | `30` | Backfill window size |
| `GOOGLE_ADS_API_VERSION` | no | `v25` | REST API version |
| `GOOGLE_ADS_MAX_RETRIES` | no | `5` | Retries for transient errors |
| `SUPABASE_DB_URL` | for live sync | – | Postgres connection string |
| `SUPABASE_DB_SSL` | no | `require` | `require`, `verify` (with CA file) or `disable` (local only) |
| `SUPABASE_DB_SSL_CA_FILE` | with `verify` | – | Supabase CA certificate path |

The job validates all of these at startup. If any are missing it exits
immediately, naming the missing variables but never printing their values.

## 4. Local setup

```bash
cd ingestion/google-ads
npm install
cp .env.example .env      # fill in values; .env is git-ignored
npm test                  # unit tests, no credentials needed
npm run google-ads:test   # DB connection + Google auth check
```

## 5. Dry run (do this before the first live import)

```bash
npm run google-ads:dry-run
npm run google-ads:dry-run -- --start 2026-10-01 --end 2026-10-02
```

A dry run authenticates, calls Google Ads, validates every row, and prints
counts, totals, rejected samples, the first fact rows that *would* be written,
and coverage warnings.

- It writes nothing: no `import_log` row, no raw, staging or core rows.
- If `SUPABASE_DB_URL` is set, it also opens a **read-only** transaction to
  report how many fact rows would be inserted vs. updated and to check
  `dim_date` coverage.

## 6. Live sync

```bash
npm run google-ads:sync                                      # today−7 … today
npm run google-ads:sync -- --start 2026-10-01 --end 2026-10-01   # small first import
npm run google-ads:sync -- --customer 123-456-7890            # one account only
npm run google-ads:status                                    # freshness / last import
```

"Today" is computed in the **ad account's time zone** (read from the API), so
the window matches Google Ads' own dates.

Exit codes: `0` success, `2` partial (some rows rejected), `1` failed,
`3` another sync is already running. Add `--json` for machine-readable output.

Suggested schedule: once or twice a day, e.g. `0 7,19 * * *` (any cron
runner: GitHub Actions, Render Cron Job, a server crontab). The job takes a
Postgres advisory lock, so overlapping runs are safe (the second exits with
code 3).

## 7. Historical backfill

Only do this after a 7-day sync has run successfully and been checked.

```bash
npm run google-ads:backfill -- --days 90 --dry-run
npm run google-ads:backfill -- --days 90
npm run google-ads:backfill -- --days 180
npm run google-ads:backfill -- --start 2025-01-01 --end 2025-06-30
```

- Backfills reuse the same pipeline, split into `GOOGLE_ADS_BACKFILL_CHUNK_DAYS`
  windows. Each window gets its own `import_log` row, so a failure only
  affects one window and can be re-run.
- A backfill stops at the first failed window.
- `core.dim_date` covers 2024-01-01 … 2030-12-31. Rows outside that range are
  rejected with a clear reason.

## 8. Database flow

| Step | Table | Operation |
| --- | --- | --- |
| 1 | `admin.import_log` | `INSERT` with `source='google_ads'`, `source_type='api'`, `status='running'` |
| 2 | `raw.google_ads_daily` | `INSERT` one row per API row: IDs plus `payload = {api_version, resource, row}`. Committed on its own so it survives later failures. Rejected rows are kept here too. |
| 3 | `staging.google_ads_daily` | `INSERT` the accepted rows, linked by `raw_id`/`import_id` |
| 4 | `core.dim_campaign` | `INSERT … ON CONFLICT (platform_key, source_campaign_id) DO UPDATE`. Name, status and objective take the latest values. `first_seen_date` only moves earlier and `last_seen_date` only moves later. |
| 5 | `core.fact_google_ads` | `INSERT … SELECT sum(...) GROUP BY grain ON CONFLICT (date_key, source_campaign_id, source_ad_group_id, source_ad_id) DO UPDATE … WHERE values changed` |
| 6 | checks | See below. Any error-level failure rolls back steps 3–5. |
| 7 | `admin.import_log` | `status`, `completed_at`, `records_received/inserted/updated/rejected`, `error_message` |

`records_inserted` / `records_updated` count **core fact rows**. A re-sync
whose numbers didn't change reports `0 / 0` (the rows show as *unchanged* in
the CLI output).

### Validation and reconciliation

Every run prints the date range, API records received, raw rows written,
staging rows processed, campaigns and facts inserted/updated/unchanged,
rejected count, and totals (impressions, clicks, spend, conversions,
conversion value). It then runs these checks over the window:

| Check | Severity |
| --- | --- |
| No duplicate logical fact keys | error |
| No fact rows missing campaign / ad group / ad ID | error |
| No orphan or mismatched `campaign_key` | error |
| No orphan `date_key` | error |
| No negative spend / impressions / clicks | error |
| No staging dates outside the requested window | error |
| Staging totals equal core values for every key loaded | error |
| Fact rows in the window that Google no longer returned | warning |
| Campaign-level spend not covered by ad-level rows (e.g. Performance Max) | warning |

Status rules: `failed` if any error-level check fails (core is rolled back;
raw is kept), otherwise `partial` if any rows were rejected, otherwise
`success`.

### Data freshness

`npm run google-ads:status` reports the last import (any status, with
`error_message`), the last `success`, the last time data was loaded, the
latest business date in `core`, and the fact row count. The existing
`analytics.data_freshness` view keeps working because it reads
`raw.google_ads_daily`. Equivalent SQL for a dashboard:

```sql
SELECT status, started_at, completed_at, business_date_start, business_date_end,
       records_received, records_inserted, records_updated, records_rejected, error_message
FROM admin.import_log WHERE source = 'google_ads'
ORDER BY started_at DESC LIMIT 1;
```

## 9. Idempotency

The 7-day lookback re-downloads data on purpose, because Google revises
conversions after the fact. Re-runs are safe because:

- **Core is protected by constraints, not application checks.** Both upserts
  target the *existing* unique constraints, so a duplicate fact or campaign
  row is impossible at the database level, even with concurrent writers.
- **Restated values overwrite.** Changed rows are updated in place with a new
  `imported_at`. Unchanged rows aren't touched.
- **Duplicates in one API response** (same date/ad/device/network) are
  rejected before load, so they can't be double-counted.
- **NULL keys.** Postgres `UNIQUE` doesn't treat NULLs as equal. That's why
  every ID is required in staging, and why the post-load check fails the
  import if a NULL-key fact row appears in the window.
- **Raw and staging are append-only per import** (keyed by `import_id`). They
  are the audit trail. Only the current import's staging rows feed core.
- **One sync at a time**, enforced by a Postgres advisory lock.

**Deletions.** If Google stops returning a row that was loaded earlier (for
example, fully restated to zero), the old fact row is *not* deleted
automatically. The `no_stale_fact_rows` warning reports how many exist.

## 10. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Missing required environment variables: …` | Set them in `.env` or the scheduler's secrets |
| `refresh token is expired or revoked (invalid_grant)` | Re-run the OAuth consent flow. If tokens die after 7 days, publish the OAuth consent screen. |
| `OAuth client rejected (invalid_client)` | Wrong `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` |
| `DEVELOPER_TOKEN_NOT_APPROVED` / `…_TEST_ACCOUNTS` | The developer token still has Test access; apply for Basic |
| `USER_PERMISSION_DENIED` | The OAuth user can't see the account, or `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is missing or wrong for MCC access |
| `is a manager (MCC) account` | Put the client account in `GOOGLE_ADS_CUSTOMER_ID` and the MCC in `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| `RESOURCE_EXHAUSTED` with a long retry delay | Daily API quota used up. The job fails fast; re-run later. |
| `Could not connect to Supabase Postgres` | Check the URI and password, and that the IPv4 *pooler* URI is used if the host has no IPv6 |
| Exit code 3 | Another sync holds the lock. If none is running, the lock was released when the old session ended; just re-run. |
| Status `partial` | See `import_log.error_message` for grouped reasons. The original rows are in raw: `SELECT r.* FROM raw.google_ads_daily r LEFT JOIN staging.google_ads_daily s ON s.raw_id = r.raw_id WHERE r.import_id = '<id>' AND s.raw_id IS NULL` |
| Status `failed` with "Integrity checks failed" | Core was rolled back. Fix the reported rows, then re-run the same window. |
| Warning "campaign-level spend with no ad-level rows" | Performance Max / Smart campaigns have no ads; see Known limitations |
| `failed` row with empty date range | The run failed before the account time zone was read (usually auth) |

## Known limitations

- **Performance Max and other ad-less campaign types.** `core.fact_google_ads`
  has ad-level grain (`source_ad_group_id`, `source_ad_id`). Performance Max
  has no ad groups or ads, so its spend can't be loaded without either
  placeholder IDs or a schema change. The job detects and reports the
  unloaded spend per campaign on every run; it doesn't silently drop it.
  Choosing how to load it needs a decision (see the project README / PR notes).
- **Currency.** Spend is stored in the account currency (`cost_micros / 1e6`,
  computed exactly). Staging and core have no currency column. The account
  currency is printed on every run, and rows in any other currency are
  rejected.
- **No customer column in core.** With several accounts, facts are kept apart
  by their globally unique campaign/ad IDs, but can't be filtered by account
  in core.

## Tests

```bash
npm test                    # unit: dates, normalization, numeric parsing, API retry/auth/pagination, statuses, config
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm run test:integration
```

Integration tests create a throwaway **local** database (non-local hosts are
refused) from `test/fixtures/live-schema.sql`, a replica of the live Supabase
DDL and analytics views. They run the full pipeline: first load, idempotent
re-run, restatement, backfill, rejected rows, API failure, DB failure rollback,
integrity-check rollback, PMax gap warning, paginated REST client, lock,
freshness, and that the analytics views read the loaded data.
