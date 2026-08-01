const express = require("express");
const { findCustomerByMembershipId } = require("../services/ghlClient");
const {
  isMockModeEnabled,
  mockFindCustomerByMembershipId,
} = require("../services/mockData");

const router = express.Router();

/** GET /api/customers/lookup?membershipId=BP-100234 */
router.get("/lookup", async (req, res) => {
  const membershipId = (req.query.membershipId || "").toString().trim();

  if (!membershipId) {
    return res.status(400).json({ ok: false, reason: "invalid_request" });
  }

  try {
    const customer = isMockModeEnabled()
      ? mockFindCustomerByMembershipId(membershipId)
      : await findCustomerByMembershipId(membershipId);

    if (!customer) {
      return res.status(404).json({ ok: false, reason: "not_found" });
    }

    return res.status(200).json({ ok: true, customer });
  } catch (error) {
    console.error("Lookup failed", error);
    return res.status(502).json({ ok: false, reason: "upstream_error" });
  }
});

module.exports = router;
