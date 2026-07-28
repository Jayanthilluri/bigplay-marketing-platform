# Big Play Marketing Platform

Internal marketing, loyalty, promotions, analytics, and customer engagement
platform for Big Play Entertainment.

## Module 1: Players Club Redemption Portal

Employee-facing tool for looking up Players Club members and redeeming
their available promotions/rewards.

**Status:** Phase 1 — frontend prototype with mock data (no backend yet).

### Run it locally

The Phase 1 portal is fully static. Serve `frontend/players-club/` with any
static file server, e.g.:

```bash
cd frontend/players-club
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a browser.

Demo membership IDs:

| Membership ID | Scenario |
| --- | --- |
| `BP-100234` | Eligible customer, reward ready to redeem |
| `BP-100777` | Reward already redeemed |
| `BP-100999` | Promotion expired |
| anything else | Customer not found |

## Project Structure

```
frontend/
  players-club/        # Players Club Redemption Portal (Phase 1)
    index.html
    styles.css
    app.js
    assets/             # Logo and static images
    icons/              # UI icon assets

backend/                # Reserved for the future Node/Express REST API
  api/
  routes/
  controllers/
  middleware/
  services/

docs/                   # Project documentation
```

## Tech Stack

- **Frontend:** HTML5, CSS3, vanilla JavaScript (ES6+), mobile-first responsive design
- **Backend (future):** Node.js, Express, REST API
- **Future integrations:** GoHighLevel, Toast POS, Intercard, Brunswick, Zapier
- **Deployment:** GitHub, Cloudflare Pages, Cloudflare Workers (future)

## Roadmap

Planned, not yet implemented:

- Employee / Manager / Admin authentication
- Admin dashboard
- Promotion engine (birthday, corporate, holiday promotions)
- QR code generator
- Analytics dashboard
- GoHighLevel, Toast, and Intercard integrations
