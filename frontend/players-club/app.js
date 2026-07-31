/**
 * Big Play Entertainment — Players Club Redemption Portal
 *
 * Architecture notes:
 *  - `CustomerService` is the single seam this app talks to for lookups/redemptions.
 *    It calls the Cloudflare Worker API (backend/worker), which proxies to
 *    GoHighLevel and keeps the API key server-side. The Worker falls back to
 *    mock data automatically when it has no GHL key configured, so this file
 *    behaves identically against a live or demo backend.
 *  - `UIController` owns DOM state transitions only; it has no knowledge of where
 *    customer data comes from.
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------
   * Config
   * ---------------------------------------------------------------- */
  // Points at the Worker deployment. Override by setting
  // `window.BP_API_BASE_URL` before this script loads (e.g. in a small
  // inline snippet per-environment) for local dev vs. production.
  const API_BASE_URL = window.BP_API_BASE_URL || "";

  /* ------------------------------------------------------------------
   * Customer Service — talks to the backend API
   * ---------------------------------------------------------------- */
  const CustomerService = {
    /**
     * Looks up a customer by membership ID.
     * @param {string} membershipId
     * @returns {Promise<{ok: true, customer: object} | {ok: false, reason: string}>}
     */
    async lookup(membershipId) {
      const normalizedId = membershipId.trim().toUpperCase();

      try {
        const response = await fetch(
          `${API_BASE_URL}/api/customers/lookup?membershipId=${encodeURIComponent(normalizedId)}`
        );
        const data = await response.json();
        return data;
      } catch (error) {
        console.error("Customer lookup failed", error);
        return { ok: false, reason: "network_error" };
      }
    },

    /**
     * Redeems the reward currently associated with a customer.
     * @param {object} customer
     * @returns {Promise<{ok: true, transaction: object} | {ok: false, reason: string}>}
     */
    async redeem(customer) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/redemptions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            membershipId: customer.membershipId,
            ghlContactId: customer.ghlContactId,
            redemptionState: customer.redemptionState,
          }),
        });
        const data = await response.json();
        return data;
      } catch (error) {
        console.error("Redemption failed", error);
        return { ok: false, reason: "network_error" };
      }
    },
  };

  function getInitials(fullName) {
    return fullName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("");
  }

  function formatDateTime(date) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  const REDEMPTION_STATE_LABELS = {
    ready: { label: "Ready to Redeem", tagClass: "tag--ready" },
    redeemed: { label: "Already Redeemed", tagClass: "tag--redeemed" },
    expired: { label: "Expired", tagClass: "tag--expired" },
  };

  const FAILURE_MESSAGES = {
    not_found: {
      title: "Customer Not Found",
      message:
        "We couldn't find a Players Club member with that ID. Please check the membership ID and try again.",
    },
    already_redeemed: {
      title: "Already Redeemed",
      message: "This reward has already been redeemed and cannot be used again.",
    },
    expired: {
      title: "Promotion Expired",
      message: "This promotion has expired and is no longer eligible for redemption.",
    },
    network_error: {
      title: "Connection Problem",
      message: "We couldn't reach the server. Check your connection and try again.",
    },
    upstream_error: {
      title: "Service Unavailable",
      message: "The Players Club system is temporarily unavailable. Please try again shortly.",
    },
  };

  /* ------------------------------------------------------------------
   * UI Controller — DOM state machine
   * ---------------------------------------------------------------- */
  const UIController = (function () {
    const states = {
      search: document.getElementById("stateSearch"),
      loading: document.getElementById("stateLoading"),
      customer: document.getElementById("stateCustomer"),
      success: document.getElementById("stateSuccess"),
      failure: document.getElementById("stateFailure"),
    };

    const elements = {
      searchForm: document.getElementById("searchForm"),
      membershipInput: document.getElementById("membershipId"),
      btnScanQr: document.getElementById("btnScanQr"),
      btnCancel: document.getElementById("btnCancel"),
      btnRedeem: document.getElementById("btnRedeem"),
      btnNewRedemption: document.getElementById("btnNewRedemption"),
      btnTryAgain: document.getElementById("btnTryAgain"),

      customerAvatar: document.getElementById("customerAvatar"),
      customerName: document.getElementById("customerName"),
      customerStatus: document.getElementById("customerStatus"),
      customerMembershipId: document.getElementById("customerMembershipId"),
      customerPromotion: document.getElementById("customerPromotion"),
      customerReward: document.getElementById("customerReward"),
      customerRedemptionStatus: document.getElementById("customerRedemptionStatus"),

      successCustomer: document.getElementById("successCustomer"),
      successReward: document.getElementById("successReward"),
      successDate: document.getElementById("successDate"),
      successTransactionId: document.getElementById("successTransactionId"),

      failureTitle: document.getElementById("failureTitle"),
      failureMessage: document.getElementById("failureMessage"),
    };

    /** @type {object|null} Currently loaded customer record, held for redemption. */
    let activeCustomer = null;

    function showState(stateName) {
      Object.entries(states).forEach(([name, el]) => {
        el.classList.toggle("card-state--active", name === stateName);
      });
    }

    function renderCustomer(customer) {
      activeCustomer = customer;

      elements.customerAvatar.textContent = getInitials(customer.name);
      elements.customerName.textContent = customer.name;
      elements.customerStatus.textContent = customer.membershipStatus;
      elements.customerMembershipId.textContent = customer.membershipId;
      elements.customerPromotion.textContent = customer.promotion;
      elements.customerReward.textContent = customer.reward;

      const redemptionInfo =
        REDEMPTION_STATE_LABELS[customer.redemptionState] || REDEMPTION_STATE_LABELS.ready;

      elements.customerRedemptionStatus.textContent = redemptionInfo.label;
      elements.customerRedemptionStatus.className = `tag ${redemptionInfo.tagClass}`;

      const canRedeem = customer.redemptionState === "ready";
      elements.btnRedeem.disabled = !canRedeem;
      elements.btnRedeem.style.opacity = canRedeem ? "1" : "0.5";
      elements.btnRedeem.style.cursor = canRedeem ? "pointer" : "not-allowed";

      showState("customer");
    }

    function renderFailure(reasonKey) {
      const failure = FAILURE_MESSAGES[reasonKey] || FAILURE_MESSAGES.not_found;
      elements.failureTitle.textContent = failure.title;
      elements.failureMessage.textContent = failure.message;
      showState("failure");
    }

    function renderSuccess(customer, transaction) {
      elements.successCustomer.textContent = customer.name;
      elements.successReward.textContent = customer.reward;
      elements.successDate.textContent = formatDateTime(new Date(transaction.redeemedAt));
      elements.successTransactionId.textContent = transaction.transactionId;
      showState("success");
    }

    function resetToSearch() {
      activeCustomer = null;
      elements.membershipInput.value = "";
      elements.membershipInput.classList.remove("is-invalid");
      showState("search");
      elements.membershipInput.focus({ preventScroll: true });
    }

    async function handleLookup(membershipId) {
      if (!membershipId) {
        elements.membershipInput.classList.add("is-invalid");
        elements.membershipInput.focus();
        return;
      }

      elements.membershipInput.classList.remove("is-invalid");
      showState("loading");

      const result = await CustomerService.lookup(membershipId);

      if (result.ok) {
        renderCustomer(result.customer);
      } else {
        renderFailure(result.reason);
      }
    }

    async function handleRedeem() {
      if (!activeCustomer || activeCustomer.redemptionState !== "ready") {
        return;
      }

      showState("loading");
      const result = await CustomerService.redeem(activeCustomer);

      if (result.ok) {
        renderSuccess(activeCustomer, result.transaction);
      } else {
        renderFailure(result.reason);
      }
    }

    function handleScanQr() {
      // Placeholder for camera-based QR scanning (future: device camera + QR decoder).
      // For Phase 1 this focuses the manual entry field so employees can proceed.
      window.alert(
        "QR scanning requires camera access and is not yet available in this demo.\n" +
          "Please enter a Membership ID manually to continue."
      );
      elements.membershipInput.focus();
    }

    function bindEvents() {
      elements.searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        handleLookup(elements.membershipInput.value);
      });

      elements.btnScanQr.addEventListener("click", handleScanQr);
      elements.btnCancel.addEventListener("click", resetToSearch);
      elements.btnRedeem.addEventListener("click", handleRedeem);
      elements.btnNewRedemption.addEventListener("click", resetToSearch);
      elements.btnTryAgain.addEventListener("click", resetToSearch);

      elements.membershipInput.addEventListener("input", () => {
        elements.membershipInput.classList.remove("is-invalid");
      });
    }

    function init() {
      bindEvents();
      showState("search");
    }

    return { init };
  })();

  /* ------------------------------------------------------------------
   * Bootstrap
   * ---------------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    UIController.init();

    const yearEl = document.getElementById("year");
    if (yearEl) {
      yearEl.textContent = new Date().getFullYear().toString();
    }
  });
})();
