/**
 * ============================================================
 *  TEMPORARY DEBUG-ONLY ROUTE — DELETE AFTER DIAGNOSIS
 * ============================================================
 *
 * GET /api/debug/contact-fields?contactId=<id>
 *
 * Exists solely to inspect the raw GHL customFields payload for the
 * known-good test contact while diagnosing the Promotion/Reward
 * field-key mismatch. Hard-restricted to that one contact ID so this
 * can't become a general-purpose "fetch any contact's data" endpoint
 * while it's live. Requires the same employee Bearer auth as every
 * other protected route — no new auth mechanism, no new secrets.
 *
 * Returns ONLY: contact ID + customFields (key/id/value). No name,
 * email, phone, or any other PII. Never returns GHL_API_KEY or any
 * authorization header/token.
 *
 * Remove this file and its mount in server.js once the field-key
 * mismatch is confirmed and fixed.
 */

const express = require("express");
const { getRawCustomFields } = require("../services/ghlClient");
const { isMockModeEnabled } = require("../services/mockData");
const { requireEmployeeAuth } = require("../middleware/auth");

const router = express.Router();

// Only this contact may be inspected through this temporary endpoint.
const ALLOWED_DEBUG_CONTACT_ID = "topTQpHLTUqhXk44kb8Q";

router.get("/contact-fields", requireEmployeeAuth, async (req, res) => {
  const contactId = (req.query.contactId || "").toString().trim();

  if (contactId !== ALLOWED_DEBUG_CONTACT_ID) {
    return res.status(403).json({
      ok: false,
      reason: "debug_endpoint_restricted",
      message: "This temporary diagnostic endpoint only supports the known test contact.",
    });
  }

  if (isMockModeEnabled()) {
    return res.status(409).json({
      ok: false,
      reason: "mock_mode",
      message: "Backend is running in mock mode (GHL_API_KEY not set) — no live GHL data to inspect.",
    });
  }

  try {
    const result = await getRawCustomFields(contactId);

    if (!result) {
      return res.status(404).json({ ok: false, reason: "not_found" });
    }

    return res.status(200).json({
      ok: true,
      debug: true,
      contactId: result.contactId,
      customFields: result.customFields,
    });
  } catch (error) {
    console.error("Debug contact-fields lookup failed:", error.message);
    return res.status(502).json({ ok: false, reason: "upstream_error" });
  }
});

module.exports = router;
