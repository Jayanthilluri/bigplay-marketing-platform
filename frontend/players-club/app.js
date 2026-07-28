/**
 * Big Play Entertainment — Players Club Redemption Portal
 * Phase 1: Frontend-only prototype backed by mock customer data.
 *
 * Architecture notes:
 *  - `CustomerService` is the single seam this app talks to for lookups/redemptions.
 *    In Phase 1 it resolves against MOCK_CUSTOMERS. Swapping it for real HTTP calls
 *    to the future Node/Express API (GoHighLevel/Toast/Intercard-backed) should not
 *    require touching the UI controller below.
 *  - `UIController` owns DOM state transitions only; it has no knowledge of where
 *    customer data comes from.
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------
   * Mock Data (Phase 1 — replaced by backend API in a later phase)
   * ---------------------------------------------------------------- */
  const MOCK_CUSTOMERS = {
    "BP-100234": {
      membershipId: "BP-100234",
      name: "John Smith",
      membershipStatus: "Players Club Member",
      eligibility: "Eligible",
      promotion: "Summer Free Play Giveaway",
      reward: "Free $10 Game Card",
      redemptionState: "ready", // ready | redeemed | expired
    },
    "BP-100777": {
      membershipId: "BP-100777",
      name: "Maria Alvarez",
      membershipStatus: "Players Club VIP",
      eligibility: "Eligible",
      promotion: "Birthday Rewards",
      reward: "50 Bonus Arcade Credits",
      redemptionState: "redeemed",
    },
    "BP-100999": {
      membershipId: "BP-100999",
      name: "David Chen",
      membershipStatus: "Players Club Member",
      eligibility: "Eligible",
      promotion: "Holiday Promotion",
      reward: "Free Laser Tag Pass",
      redemptionState: "expired",
    },
  };

  const SIMULATED_LOOKUP_DELAY_MS = 900;
  const SIMULATED_REDEEM_DELAY_MS = 1100;

  /* ------------------------------------------------------------------
   * Customer Service — mock data access layer
   * ---------------------------------------------------------------- */
  const CustomerService = {
    /**
     * Looks up a customer by membership ID.
     * @param {string} membershipId
     * @returns {Promise<{ok: true, customer: object} | {ok: false, reason: string}>}
     */
    lookup(membershipId) {
      const normalizedId = membershipId.trim().toUpperCase();

      return new Promise((resolve) => {
        setTimeout(() => {
          const customer = MOCK_CUSTOMERS[normalizedId];
          if (!customer) {
            resolve({ ok: false, reason: "not_found" });
            return;
          }
          resolve({ ok: true, customer: { ...customer } });
        }, SIMULATED_LOOKUP_DELAY_MS);
      });
    },

    /**
     * Redeems the reward currently associated with a customer.
     * @param {object} customer
     * @returns {Promise<{ok: true, transaction: object} | {ok: false, reason: string}>}
     */
    redeem(customer) {
      return new Promise((resolve) => {
        setTimeout(() => {
          if (customer.redemptionState === "redeemed") {
            resolve({ ok: false, reason: "already_redeemed" });
            return;
          }
          if (customer.redemptionState === "expired") {
            resolve({ ok: false, reason: "expired" });
            return;
          }

          // Mark redeemed in the mock store so re-lookups reflect the change.
          if (MOCK_CUSTOMERS[customer.membershipId]) {
            MOCK_CUSTOMERS[customer.membershipId].redemptionState = "redeemed";
          }

          resolve({
            ok: true,
            transaction: {
              transactionId: generateTransactionId(),
              redeemedAt: new Date(),
            },
          });
        }, SIMULATED_REDEEM_DELAY_MS);
      });
    },
  };

  function generateTransactionId() {
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    return `TXN-${timestamp}-${random}`;
  }

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
      elements.successDate.textContent = formatDateTime(transaction.redeemedAt);
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
