# Big Play Marketing Platform

Internal marketing, loyalty, promotions, analytics, and customer engagement
platform for Big Play Entertainment.

## Module 1: Players Club Redemption Portal

Employee-facing tool for looking up Players Club members and redeeming
their available promotions/rewards, backed by GoHighLevel.

**Status:** Live-data phase — Cloudflare Worker backend proxying GoHighLevel
contacts. See [`docs/ghl-integration.md`](docs/ghl-integration.md) for setup
and deployment.

### Run it locally

**Backend (Worker):**

```bash
cd backend/worker
npm install
npx wrangler dev
```

Without a `GHL_API_KEY` configured, the Worker automatically serves the same
mock data as before, so it runs standalone with no GHL account needed.

**Frontend:**

```bash
cd frontend/players-club
python3 -m http.server 8080
```

Then open `http://localhost:8080`, with `window.BP_API_BASE_URL` in
`index.html` pointed at the Worker (`http://localhost:8787` for local dev).

Demo membership IDs (mock mode):

| Membership ID | Scenario |
| --- | --- |
| `BP-100234` | Eligible customer, reward ready to redeem |
| `BP-100777` | Reward already redeemed |
| `BP-100999` | Promotion expired |
| anything else | Customer not found |

## Project Structure

```
frontend/
  players-club/        # Players Club Redemption Portal
    index.html
    styles.css
    app.js
    assets/             # Logo and static images
    icons/              # UI icon assets

backend/
  worker/               # Cloudflare Worker: GHL proxy API (live backend)
    src/
      index.js
      routes/
      services/         # ghlClient.js (real GHL calls), mockData.js (fallback)
      middleware/
    wrangler.toml
  api/ routes/ controllers/ middleware/ services/
                        # Reserved for a future standalone Node/Express API

docs/
  ghl-integration.md    # GHL field setup, secrets, deploy steps, pre-launch checklist
```

## Tech Stack

- **Frontend:** HTML5, CSS3, vanilla JavaScript (ES6+), mobile-first responsive design
- **Backend:** Cloudflare Worker (GHL proxy); Node/Express reserved for future modules
- **Live integration:** GoHighLevel (Contacts API)
- **Future integrations:** Toast POS, Intercard, Brunswick, Zapier
- **Deployment:** GitHub, Cloudflare Pages, Cloudflare Workers

## Roadmap

Planned, not yet implemented:

- Employee / Manager / Admin authentication
- Admin dashboard
- Promotion engine (birthday, corporate, holiday promotions)
- QR code generator
- Analytics dashboard
- Toast and Intercard integrations
