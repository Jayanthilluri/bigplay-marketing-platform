/**
 * GoHighLevel (LeadConnector) API client.
 *
 * Isolates all GHL HTTP calls behind a small interface so the route
 * handlers don't need to know about GHL's request/response shapes. This
 * mirrors backend/worker/src/services/ghlClient.js exactly (same field
 * mapping, same search/update strategy) so the two backends behave
 * identically — only the HTTP client (axios vs. fetch) and env access
 * (process.env vs. Worker env bindings) differ.
 *
 * NOTE: The advanced contact search filter syntax below (filtering by a
 * custom field via `customFields.<fieldKey>`) matches GoHighLevel's
 * documented v2 Search Contacts behavior, but was not exercised against a
 * live account while building this. Run the smoke test in
 * docs/ghl-integration.md against your real location before go-live.
 */

const axios = require("axios");

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

function buildHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Custom field keys expected on the GHL Contact record. These must match
 * the "Field Key" of custom fields created in the GHL location (Settings ->
 * Custom Fields), configurable via env so they can be renamed without a
 * code change.
 */
function fieldKeys() {
  return {
    membershipId: process.env.GHL_FIELD_MEMBERSHIP_ID || "membership_id",
    membershipStatus: process.env.GHL_FIELD_MEMBERSHIP_STATUS || "membership_status",
    promotion: process.env.GHL_FIELD_PROMOTION || "active_promotion",
    reward: process.env.GHL_FIELD_REWARD || "active_reward",
    redemptionStatus: process.env.GHL_FIELD_REDEMPTION_STATUS || "redemption_status",
    redeemedAt: process.env.GHL_FIELD_REDEEMED_AT || "redeemed_at",
  };
}

function getCustomFieldValue(contact, fieldKey) {
  const field = (contact.customFields || []).find(
    (entry) => entry.key === fieldKey || entry.id === fieldKey
  );
  return field ? field.value : undefined;
}

function normalizeRedemptionState(rawValue) {
  const value = (rawValue || "").toString().trim().toLowerCase();
  if (value === "redeemed") return "redeemed";
  if (value === "expired") return "expired";
  return "ready";
}

/**
 * Maps a raw GHL contact record into the shape the frontend expects.
 */
function mapContactToCustomer(contact) {
  const keys = fieldKeys();
  const name =
    contact.contactName ||
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    contact.email ||
    "Unknown Customer";

  return {
    membershipId: getCustomFieldValue(contact, keys.membershipId) || contact.id,
    name,
    membershipStatus: getCustomFieldValue(contact, keys.membershipStatus) || "Players Club Member",
    promotion: getCustomFieldValue(contact, keys.promotion) || "No Active Promotion",
    reward: getCustomFieldValue(contact, keys.reward) || "No Reward Available",
    redemptionState: normalizeRedemptionState(getCustomFieldValue(contact, keys.redemptionStatus)),
    ghlContactId: contact.id,
  };
}

/**
 * Fetches a single contact directly by its GHL contact ID.
 * Used for QR codes that carry ?contactId=<GHL id>. Treats "bad id"
 * responses (400/404/422) as not-found rather than upstream errors, since
 * arbitrary employee-typed strings also flow through here as a fallback.
 * @returns {Promise<object|null>} mapped customer, or null if not found
 */
async function getContactById(contactId) {
  const response = await axios.get(
    `${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}`,
    { headers: buildHeaders(), validateStatus: () => true }
  );

  if ([400, 404, 422].includes(response.status)) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GHL get contact failed (${response.status}): ${JSON.stringify(response.data)}`);
  }

  const contact = response.data.contact || response.data;
  if (!contact || !contact.id) return null;

  return mapContactToCustomer(contact);
}

/**
 * Looks up a single contact by the membership ID custom field.
 * @returns {Promise<object|null>} mapped customer, or null if not found
 */
async function findCustomerByMembershipId(membershipId) {
  const keys = fieldKeys();

  const response = await axios.post(
    `${GHL_API_BASE}/contacts/search`,
    {
      locationId: process.env.GHL_LOCATION_ID,
      pageLimit: 1,
      filters: [
        {
          field: `customFields.${keys.membershipId}`,
          operator: "eq",
          value: membershipId,
        },
      ],
    },
    { headers: buildHeaders(), validateStatus: () => true }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GHL search failed (${response.status}): ${JSON.stringify(response.data)}`);
  }

  const contact = (response.data.contacts || [])[0];
  if (!contact) return null;

  return mapContactToCustomer(contact);
}

/**
 * Marks the active reward as redeemed on the contact record.
 * `redeemedBy` is only written when the optional GHL_FIELD_REDEEMED_BY env
 * var names a custom field — this way the audit column can be added in GHL
 * later without blocking deployment (see docs/ghl-integration.md).
 * @returns {Promise<{ok: boolean}>}
 */
async function redeemCustomerReward(ghlContactId, redeemedAtIso, redeemedBy) {
  const keys = fieldKeys();

  const customFields = [
    { key: keys.redemptionStatus, field_value: "redeemed" },
    { key: keys.redeemedAt, field_value: redeemedAtIso },
  ];
  if (process.env.GHL_FIELD_REDEEMED_BY && redeemedBy) {
    customFields.push({
      key: process.env.GHL_FIELD_REDEEMED_BY,
      field_value: String(redeemedBy).slice(0, 64),
    });
  }

  const response = await axios.put(
    `${GHL_API_BASE}/contacts/${encodeURIComponent(ghlContactId)}`,
    { customFields },
    { headers: buildHeaders(), validateStatus: () => true }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GHL update failed (${response.status}): ${JSON.stringify(response.data)}`);
  }

  return { ok: true };
}

/**
 * Shared validator for identifiers arriving from the browser (membership
 * IDs and GHL contact IDs). Rejects anything that couldn't be either.
 */
function isValidCustomerId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

module.exports = {
  findCustomerByMembershipId,
  getContactById,
  redeemCustomerReward,
  mapContactToCustomer,
  isValidCustomerId,
};
