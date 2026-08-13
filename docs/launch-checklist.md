# Players Club Redemption Portal — Monday Launch Checklist

Production URLs:

- Frontend: `https://bigplay-players-club.onrender.com`
- Backend: `https://bigplay-marketing-platform.onrender.com`

## 1. Render configuration (before deploying)

On the **backend** service → Environment:

- [ ] `GHL_API_KEY` — set (existing)
- [ ] `GHL_LOCATION_ID` — set (existing)
- [ ] `EMPLOYEE_PIN` — **new, required.** Pick a PIN staff will use; without it every login is rejected in live mode.
- [ ] `ALLOWED_ORIGIN` = `https://bigplay-players-club.onrender.com` — **replace any `*`**.
- [ ] (optional) `GHL_FIELD_REDEEMED_BY` = `redeemed_by` — only after creating that custom field in GHL.

## 2. GoHighLevel setup

- [ ] Contact custom fields exist with keys: `membership_id`, `membership_status`,
      `active_promotion`, `active_reward`, `redemption_status`, `redeemed_at`
      (already in place if the current live flow works).
- [ ] `redemption_status` for launch-eligible members is set to `ready`.
- [ ] (optional) Create a `redeemed_by` text field for the audit trail, then set
      `GHL_FIELD_REDEEMED_BY` on Render.

## 3. Deploy

- [ ] Merge the release branch; let both Render services auto-deploy (or Manual Deploy each).
- [ ] `curl https://bigplay-marketing-platform.onrender.com/api/health` → `{"ok":true,"mode":"live"}`.

## 4. Live smoke test (5 minutes, use the known-good test contact)

Test contact: **Xoi Hammons**, GHL contact ID `topTQpHLTUqhXk44kb8Q`.

- [ ] Open `https://bigplay-players-club.onrender.com/?contactId=topTQpHLTUqhXk44kb8Q`
      → login screen appears (not the customer).
- [ ] Enter a **wrong** PIN → "Incorrect PIN" error.
- [ ] Enter the **correct** PIN (+ your name) → Xoi Hammons loads automatically,
      no manual entry. **This confirms existing QR codes still work.**
- [ ] Confirm the raw contact ID `topTQpHLTUqhXk44kb8Q` is **not** shown anywhere on the card.
- [ ] If the test contact is `ready`: tap **Redeem Reward** → button shows
      "Redeeming…" → success screen with customer, reward, time, transaction ID.
- [ ] Check the contact in GHL: `redemption_status=redeemed`, `redeemed_at` stamped.
- [ ] Reopen the same QR URL → status shows **Already Redeemed**, redeem button disabled.
- [ ] Attempt the API directly without a token:
      `curl -X POST https://bigplay-marketing-platform.onrender.com/api/redemptions -H "Content-Type: application/json" -d '{"membershipId":"x"}'`
      → `401 {"ok":false,"reason":"unauthorized"}`.
- [ ] Tap **Scan QR Code** on a phone → camera opens (rear camera), scanning a
      member QR loads that member; Cancel closes the camera.
- [ ] Deny camera permission once → clear error message, manual entry still works.
- [ ] **Log Out** → login screen returns; reopening a QR URL demands the PIN again.

## 5. Day-of notes for staff

- The PIN is shared; each employee can type their name at sign-in so
  redemptions are attributed (shows on the success receipt / GHL audit field).
- Sessions last 12 hours; a backend restart/redeploy signs everyone out —
  just sign in again.
- First request after a quiet period can take ~30–60s (Render free plan
  cold start). The login screen appearing slowly is normal after idle time.
- If a QR won't scan (damaged/no camera), type the membership ID manually.
