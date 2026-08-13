const express = require("express");
const {
  findCustomerByMembershipId,
  getContactById,
  isValidCustomerId,
} = require("../services/ghlClient");
const {
  isMockModeEnabled,
  mockFindCustomerByMembershipId,
} = require("../services/mockData");
const { requireEmployeeAuth } = require("../middleware/auth");

const router = express.Router();

/**
 * Resolves an identifier that may be EITHER a friendly membership ID
 * (custom field) or a raw GHL contact ID — QR codes carry the latter as
 * ?contactId=<id>, and the frontend funnels both through this endpoint.
 * Search-by-field runs first to preserve the existing live behavior; the
 * direct contact fetch is a fallback that only adds coverage.
 */
async function resolveCustomer(id) {
  if (isMockModeEnabled()) {
    return mockFindCustomerByMembershipId(id);
  }
  const byField = await findCustomerByMembershipId(id);
  if (byField) return byField;
  return getContactById(id);
}

/** GET /api/customers/lookup?membershipId=BP-100234  (employee auth required) */
router.get("/lookup", requireEmployeeAuth, async (req, res) => {
  const membershipId = (req.query.membershipId || "").toString().trim();

  if (!isValidCustomerId(membershipId)) {
    return res.status(400).json({ ok: false, reason: "invalid_request" });
  }

  try {
    const customer = await resolveCustomer(membershipId);

    if (!customer) {
      return res.status(404).json({ ok: false, reason: "not_found" });
    }

    return res.status(200).json({ ok: true, customer });
  } catch (error) {
    console.error("Lookup failed:", error.message);
    return res.status(502).json({ ok: false, reason: "upstream_error" });
  }
});

module.exports = router;
module.exports.resolveCustomer = resolveCustomer;
