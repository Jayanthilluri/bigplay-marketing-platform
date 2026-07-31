# GoHighLevel Integration — Players Club Redemption Portal

This document covers what's needed to take the Players Club Redemption
Portal from mock data to live GoHighLevel (GHL) data before launch.

## Architecture

```
Browser (frontend/players-club)
   │  fetch()
   ▼
Cloudflare Worker (backend/worker)   <-- holds GHL_API_KEY as a secret
   │  HTTPS + Bearer token
   ▼
GoHighLevel API (services.leadconnectorhq.com)
```

The frontend never talks to GHL directly and never sees the API key. The
Worker is the only thing that holds credentials.

## 1. Create custom fields in GHL

In your GHL location: **Settings → Custom Fields → Contact**, create these
fields (any label is fine, but note the **Field Key** it generates — you'll
configure that key below):

| Purpose | Suggested Field Key | Example value |
| --- | --- | --- |
| Membership ID | `membership_id` | `BP-100234` |
| Membership status | `membership_status` | `Players Club Member` |
| Active promotion | `active_promotion` | `Summer Free Play Giveaway` |
| Active reward | `active_reward` | `Free $10 Game Card` |
| Redemption status | `redemption_status` | `ready`, `redeemed`, or `expired` |
| Redeemed at | `redeemed_at` | set automatically by the Worker on redemption |

If your account already has equivalent fields with different keys, you
don't need to rename them — just point the Worker's env vars (below) at
your existing keys instead.

## 2. Configure the Worker

Non-secret config lives in `backend/worker/wrangler.toml` under `[vars]`:

- `GHL_LOCATION_ID` — your GHL sub-account/location ID
- `GHL_FIELD_*` — the custom field keys from step 1 (defaults match the table above)
- `ALLOWED_ORIGIN` — set to your deployed Cloudflare Pages URL (e.g.
  `https://players-club.bigplay.pages.dev`) once you know it; keep as `*`
  only for early testing

The API key is a **secret**, not a var — never put it in `wrangler.toml` or
commit it anywhere:

```bash
cd backend/worker
npx wrangler secret put GHL_API_KEY
# paste the key when prompted
```

For local development, copy `.dev.vars.example` to `.dev.vars` (gitignored)
and fill in `GHL_API_KEY` there instead.

## 3. Deploy the Worker

```bash
cd backend/worker
npm install
npx wrangler deploy
```

This prints your Worker's URL, e.g. `https://bigplay-players-club-api.<your-subdomain>.workers.dev`.

## 4. Point the frontend at the Worker

The frontend reads `window.BP_API_BASE_URL` (see `frontend/players-club/app.js`).
Add a small inline script tag in `index.html` **before** the `app.js`
`<script>` tag, set to your deployed Worker URL:

```html
<script>window.BP_API_BASE_URL = "https://bigplay-players-club-api.<your-subdomain>.workers.dev";</script>
```

Then deploy `frontend/players-club/` to Cloudflare Pages as usual.

## 5. Mock mode / demo mode

If `GHL_API_KEY` is not set on the Worker, every request automatically
falls back to the same mock data used in Phase 1 (`BP-100234`,
`BP-100777`, `BP-100999`). This is intentional — it lets you deploy and
demo the Worker safely before GHL credentials are finalized, and lets a
staging environment run without touching production GHL data.

## ⚠️ Before you flip this live: one thing to verify

`backend/worker/src/services/ghlClient.js` searches for a contact by
membership ID using GHL's **v2 Search Contacts** endpoint
(`POST /contacts/search`) with a filter like:

```json
{
  "locationId": "...",
  "filters": [{ "field": "customFields.membership_id", "operator": "eq", "value": "BP-100234" }]
}
```

This matches GoHighLevel's documented v2 filter syntax, but it was
**written without a live account to test against** (the docs site was
unreachable from this environment while building it). Before go-live, run
one real lookup against your account and confirm it returns the expected
contact:

```bash
curl "https://<your-worker>.workers.dev/api/customers/lookup?membershipId=<a real test contact's membership ID>"
```

If it returns `{"ok":false,"reason":"upstream_error"}`, check the Worker
logs (`npx wrangler tail`) for the raw GHL error response — the most likely
fix is adjusting the filter `field` value to match how your account's
custom field is actually addressed (GHL has changed this between API
versions), or swapping to filtering by the field's internal ID instead of
its key. The rest of the integration (field mapping, redemption update,
frontend) does not depend on this detail and won't need changes.

## Redemption write-back

On redeem, the Worker updates the contact's `redemption_status` field to
`redeemed` and stamps `redeemed_at` with the current timestamp — no tags
or opportunities are touched. If your reporting depends on a tag or
pipeline stage instead, extend `redeemCustomerReward()` in `ghlClient.js`.
