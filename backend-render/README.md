# Players Club Redemption API (Render / Express)

Express backend for the Players Club Redemption Portal frontend
(`frontend/players-club`). Proxies customer lookup and redemption requests
to GoHighLevel, keeping all credentials server-side, and enforces employee
authentication for every customer-facing operation.

Production deployment:

- Backend: `https://bigplay-marketing-platform.onrender.com`
- Frontend: `https://bigplay-players-club.onrender.com`

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok: true, mode: "live" \| "mock" }` |
| POST | `/api/auth/login` | — | `{ pin, employeeName? }` → `{ ok, authenticated, token }`. Rate limited. |
| POST | `/api/auth/logout` | token | Revokes the session token. |
| GET | `/api/auth/session` | token | `{ ok, authenticated, employeeName }` |
| GET | `/api/customers/lookup?membershipId=<id>` | **required** | Look up by friendly membership ID **or** GHL contact ID. |
| POST | `/api/redemptions` | **required** | `{ membershipId, ghlContactId }` → redeems the active reward. |

Unauthenticated calls to protected endpoints return `401 { ok: false, reason: "unauthorized" }`.

### Redemption safety

`POST /api/redemptions` never trusts the browser:

1. The customer's record is **re-read from GoHighLevel immediately before
   the write** — any state the frontend sends is ignored.
2. `redeemed` → `409 already_redeemed`; anything not `ready` → `409 expired`.
3. An in-process per-customer lock rejects a second simultaneous request
   (`409 redemption_in_progress`), so a double-tap cannot redeem twice.
4. On success the contact's `redemption_status` is set to `redeemed`,
   `redeemed_at` is stamped, and (if `GHL_FIELD_REDEEMED_BY` is configured)
   the employee's name from login is written for the audit trail.

### Session model (why bearer tokens, not cookies)

The frontend and backend are different `onrender.com` subdomains, and
`onrender.com` is on the Public Suffix List — the two sites are
*third-party* to each other, so cross-site cookies (even
`SameSite=None; Secure`) are blocked by Safari and modern Chrome. Cookie
sessions are therefore impractical for this architecture.

Instead, login returns an unsigned **256-bit random token** held
server-side with a 12-hour expiry. The frontend stores it in
`localStorage` (so a session survives QR scans that open new tabs) and
sends it as `Authorization: Bearer`. Logout revokes it server-side.
Because tokens are random and stored server-side, no `SESSION_SECRET` is
needed — there is nothing to sign.

Known limitations (accepted for this MVP, documented for review):

- Sessions are **in-memory**: a redeploy/restart signs every employee out
  (they just re-enter the PIN), and it assumes a single instance (true on
  the current Render plan). Move to Redis/DB if either changes.
- `localStorage` tokens are readable by JS on the page. There are no
  third-party scripts (the QR library is vendored into this repo), which
  is what makes this acceptable; keep it that way.
- One shared PIN means no per-employee identity beyond the optional
  self-reported name captured at login.

### Login rate limiting

5 failed PIN attempts within 15 minutes locks that IP for 15 minutes
(`429 too_many_attempts`) — even for a subsequently correct PIN.

## Mock mode

If `GHL_API_KEY` is unset, lookups/redemptions run against in-memory demo
data (`BP-100234` ready / `BP-100777` redeemed / `BP-100999` expired) and
the employee PIN defaults to `1234`. **In live mode there is no default
PIN** — logins are rejected until `EMPLOYEE_PIN` is set.

## Run locally

```bash
cd backend-render
npm install
cp .env.example .env
npm run dev
```

### Test it

```bash
curl http://localhost:3000/api/health

TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"pin":"1234","employeeName":"Alex"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

curl "http://localhost:3000/api/customers/lookup?membershipId=BP-100234" \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://localhost:3000/api/redemptions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"membershipId":"BP-100234","ghlContactId":"BP-100234"}'
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Render sets this automatically; defaults to `3000` locally. |
| `GHL_API_KEY` | Live mode | GoHighLevel API key. Omit to run in mock mode. |
| `GHL_LOCATION_ID` | Live mode | GHL sub-account/location ID. |
| `EMPLOYEE_PIN` | Live mode | Employee login PIN. No default in live mode. |
| `ALLOWED_ORIGIN` | Yes (prod) | Comma-separated allowed frontend origins. Set to `https://bigplay-players-club.onrender.com` in production — never `*`. |
| `GHL_FIELD_MEMBERSHIP_ID` | No | Custom field key (default `membership_id`). |
| `GHL_FIELD_MEMBERSHIP_STATUS` | No | Default `membership_status`. |
| `GHL_FIELD_PROMOTION` | No | Default `active_promotion`. |
| `GHL_FIELD_REWARD` | No | Default `active_reward`. |
| `GHL_FIELD_REDEMPTION_STATUS` | No | Default `redemption_status`. |
| `GHL_FIELD_REDEEMED_AT` | No | Default `redeemed_at`. |
| `GHL_FIELD_REDEEMED_BY` | No | **Optional** audit field. Leave unset until the matching custom field exists in GHL; nothing breaks while unset. |

## Deploy to Render

The service already exists. To ship an update:

1. Merge the branch to the branch Render deploys from and let auto-deploy
   run (or click **Manual Deploy → Deploy latest commit** on the service).
2. In the backend service's **Environment** tab, ensure `EMPLOYEE_PIN` and
   `ALLOWED_ORIGIN=https://bigplay-players-club.onrender.com` are set, plus
   the existing `GHL_API_KEY` / `GHL_LOCATION_ID`.
3. Redeploy the **frontend** static site as well (it picks up the new
   `index.html`/`app.js`/`vendor/` files).
4. Verify: `curl https://bigplay-marketing-platform.onrender.com/api/health`
   → `{"ok":true,"mode":"live"}`.

Note: Render's free plan spins idle services down; the first request after
inactivity can take ~30–60s. A restart also clears employee sessions
(everyone just signs in again with the PIN).
