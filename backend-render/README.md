# Players Club Redemption API (Render / Express)

Express backend for the Players Club Redemption Portal frontend
(`frontend/players-club`). Proxies customer lookup and redemption requests
to GoHighLevel, keeping the GHL API key server-side only. This is a
drop-in replacement for the Cloudflare Worker in `backend/worker` — same
routes, same JSON responses, same GHL field mapping — packaged for
deployment on [Render](https://render.com) instead.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | `{ ok: true, mode: "live" \| "mock" }` |
| GET | `/api/customers/lookup?membershipId=BP-100234` | Look up a customer by membership ID |
| POST | `/api/redemptions` | Redeem the customer's active reward |

If `GHL_API_KEY` is not set, every request automatically falls back to
mock data (`BP-100234`, `BP-100777`, `BP-100999`) — the same demo IDs used
elsewhere in this project — so the API runs standalone with no GHL account
needed.

## Run locally

```bash
cd backend-render
npm install
cp .env.example .env
npm run dev
```

The server listens on `http://localhost:3000` by default (`PORT` in `.env`).

### Test it

```bash
curl http://localhost:3000/api/health

curl "http://localhost:3000/api/customers/lookup?membershipId=BP-100234"

curl -X POST http://localhost:3000/api/redemptions \
  -H "Content-Type: application/json" \
  -d '{"membershipId":"BP-100234","ghlContactId":"BP-100234","redemptionState":"ready"}'
```

## Configure environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Defaults to `3000`. Render sets this automatically. |
| `GHL_API_KEY` | For live mode | GoHighLevel API key. Omit to run in mock mode. |
| `GHL_LOCATION_ID` | For live mode | Your GHL sub-account/location ID. |
| `GHL_FIELD_MEMBERSHIP_ID` | No | Custom field key for membership ID (default `membership_id`). |
| `GHL_FIELD_MEMBERSHIP_STATUS` | No | Default `membership_status`. |
| `GHL_FIELD_PROMOTION` | No | Default `active_promotion`. |
| `GHL_FIELD_REWARD` | No | Default `active_reward`. |
| `GHL_FIELD_REDEMPTION_STATUS` | No | Default `redemption_status`. |
| `GHL_FIELD_REDEEMED_AT` | No | Default `redeemed_at`. |
| `ALLOWED_ORIGIN` | Recommended | CORS origin allowed to call this API (your Cloudflare Pages URL). Defaults to `*`. |

See [`docs/ghl-integration.md`](../docs/ghl-integration.md) at the repo
root for how to set up the corresponding custom fields in GHL, and the one
live smoke test to run before go-live (the contact search filter syntax
hasn't been verified against a real GHL account yet).

## Deploy to Render

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In the Render dashboard: **New → Blueprint**, point it at this repo. Render
   will read `render.yaml` and create the `bigplay-players-club-api` web service
   automatically (root directory `backend-render`, build `npm install`, start `npm start`).
   - Alternatively: **New → Web Service**, select this repo, set **Root Directory**
     to `backend-render`, **Build Command** to `npm install`, **Start Command** to `npm start`.
3. In the service's **Environment** tab, set `GHL_API_KEY`, `GHL_LOCATION_ID`, and
   `ALLOWED_ORIGIN` (the other `GHL_FIELD_*` vars have sane defaults baked into
   `render.yaml` — override only if your custom field keys differ).
4. Deploy. Render gives you a URL like `https://bigplay-players-club-api.onrender.com`.
5. Point the frontend at it: in `frontend/players-club/index.html`, set
   `window.BP_API_BASE_URL = "https://bigplay-players-club-api.onrender.com";`
   before the `app.js` script tag.

Note: Render's free plan spins down idle services, so the first request
after inactivity can take ~30-60s to respond — factor that into a Monday
launch if traffic will be sparse at first.
