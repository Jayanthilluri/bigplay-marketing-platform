/**
 * Big Play Entertainment — Players Club Redemption Portal
 *
 * Architecture notes:
 *  - `CustomerService` / `AuthService` are the only seams that talk to the
 *    backend API (Express on Render, backend-render/), which proxies to
 *    GoHighLevel and keeps all credentials server-side.
 *  - The employee session is a backend-issued bearer token. It lives in
 *    localStorage (not a cookie) because the frontend and backend are on
 *    different onrender.com subdomains — a public-suffix boundary — so
 *    cross-site cookies would be blocked by Safari/modern Chrome. The
 *    backend expires tokens after 12h and revokes them on logout.
 *  - `UIController` owns DOM state transitions only.
 *  - QR flow: opening the page with ?contactId=<id> or ?membershipId=<id>
 *    auto-runs the lookup (after the employee is authenticated). The
 *    in-page camera scanner feeds the same lookup path.
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------
   * Config
   * ---------------------------------------------------------------- */
  // Production default; window.BP_API_BASE_URL (set in index.html) can
  // override per environment (e.g. http://localhost:3000 for local dev).
  const API_BASE_URL =
    window.BP_API_BASE_URL || "https://bigplay-marketing-platform.onrender.com";

  const SESSION_TOKEN_KEY = "bp_employee_session";

  /* ------------------------------------------------------------------
   * Auth Service — employee session against the backend
   * ---------------------------------------------------------------- */
  const AuthService = {
    getToken() {
      try {
        return localStorage.getItem(SESSION_TOKEN_KEY) || "";
      } catch {
        return "";
      }
    },

    setToken(token) {
      try {
        if (token) localStorage.setItem(SESSION_TOKEN_KEY, token);
        else localStorage.removeItem(SESSION_TOKEN_KEY);
      } catch {
        /* Storage unavailable (private mode) — session lasts this page only. */
      }
    },

    authHeaders() {
      const token = this.getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },

    async login(pin, employeeName) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin, employeeName }),
        });
        const data = await response.json();
        if (data.ok && data.token) this.setToken(data.token);
        return data;
      } catch (error) {
        console.error("Login failed", error);
        return { ok: false, reason: "network_error" };
      }
    },

    async logout() {
      try {
        await fetch(`${API_BASE_URL}/api/auth/logout`, {
          method: "POST",
          headers: this.authHeaders(),
        });
      } catch {
        /* Best effort — the token is cleared locally regardless. */
      }
      this.setToken("");
    },

    async checkSession() {
      if (!this.getToken()) return { authenticated: false };
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/session`, {
          headers: this.authHeaders(),
        });
        const data = await response.json();
        if (!data.authenticated) this.setToken("");
        return data;
      } catch (error) {
        console.error("Session check failed", error);
        return { authenticated: false, networkError: true };
      }
    },
  };

  /* ------------------------------------------------------------------
   * Customer Service — talks to the backend API
   * ---------------------------------------------------------------- */
  const CustomerService = {
    /**
     * Looks up a customer by membership ID or GHL contact ID.
     * @param {string} membershipId
     * @returns {Promise<{ok: true, customer: object} | {ok: false, reason: string}>}
     */
    async lookup(membershipId) {
      const normalizedId = membershipId.trim();

      try {
        const response = await fetch(
          `${API_BASE_URL}/api/customers/lookup?membershipId=${encodeURIComponent(normalizedId)}`,
          { headers: AuthService.authHeaders() }
        );
        if (response.status === 401) return { ok: false, reason: "unauthorized" };
        return await response.json();
      } catch (error) {
        console.error("Customer lookup failed", error);
        return { ok: false, reason: "network_error" };
      }
    },

    /**
     * Redeems the reward for a customer. The backend re-reads the real
     * redemption status from GoHighLevel immediately before writing — the
     * state shown in this UI is never trusted for the decision.
     * @param {object} customer
     * @returns {Promise<{ok: true, transaction: object} | {ok: false, reason: string}>}
     */
    async redeem(customer) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/redemptions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...AuthService.authHeaders(),
          },
          body: JSON.stringify({
            membershipId: customer.membershipId,
            ghlContactId: customer.ghlContactId,
          }),
        });
        if (response.status === 401) return { ok: false, reason: "unauthorized" };
        return await response.json();
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
      message: "This reward has already been redeemed.",
    },
    expired: {
      title: "Promotion Expired",
      message: "This reward has expired.",
    },
    redemption_in_progress: {
      title: "Redemption In Progress",
      message: "This reward is already being redeemed on another device. Please wait a moment.",
    },
    unauthorized: {
      title: "Sign In Required",
      message: "Employee authentication required.",
    },
    invalid_request: {
      title: "Invalid ID",
      message: "That doesn't look like a valid membership ID. Please check it and try again.",
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

  const LOGIN_ERROR_MESSAGES = {
    invalid_pin: "Incorrect PIN. Please try again.",
    too_many_attempts: "Too many attempts. Please wait 15 minutes and try again.",
    not_configured: "The portal is not fully set up yet. Please contact a manager.",
    network_error: "Can't reach the server. Check your connection and try again.",
  };

  /* ------------------------------------------------------------------
   * UI Controller — DOM state machine
   * ---------------------------------------------------------------- */
  const UIController = (function () {
    const states = {
      login: document.getElementById("stateLogin"),
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

      loginForm: document.getElementById("loginForm"),
      loginPin: document.getElementById("loginPin"),
      loginName: document.getElementById("loginName"),
      loginError: document.getElementById("loginError"),
      btnSignIn: document.getElementById("btnSignIn"),
      btnLogout: document.getElementById("btnLogout"),
      employeeBadge: document.getElementById("employeeBadge"),

      customerAvatar: document.getElementById("customerAvatar"),
      customerName: document.getElementById("customerName"),
      customerStatus: document.getElementById("customerStatus"),
      rowMembershipId: document.getElementById("rowMembershipId"),
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

      scannerOverlay: document.getElementById("scannerOverlay"),
      scannerError: document.getElementById("scannerError"),
      btnCloseScanner: document.getElementById("btnCloseScanner"),
    };

    /** @type {object|null} Currently loaded customer record, held for redemption. */
    let activeCustomer = null;

    /** ID captured from the URL (QR deep link) before login completed. */
    let pendingLookupId = "";

    function showState(stateName) {
      Object.entries(states).forEach(([name, el]) => {
        el.classList.toggle("card-state--active", name === stateName);
      });
    }

    function setLoggedInUi(isLoggedIn) {
      elements.btnLogout.classList.toggle("is-hidden", !isLoggedIn);
      elements.employeeBadge.textContent = isLoggedIn
        ? "Employee Portal · Logged In"
        : "Employee Portal";
    }

    function showLogin(message) {
      setLoggedInUi(false);
      elements.loginError.textContent = message || "";
      showState("login");
      elements.loginPin.focus({ preventScroll: true });
    }

    function renderCustomer(customer) {
      activeCustomer = customer;

      elements.customerAvatar.textContent = getInitials(customer.name);
      elements.customerName.textContent = customer.name;
      elements.customerStatus.textContent = customer.membershipStatus;
      elements.customerPromotion.textContent = customer.promotion;
      elements.customerReward.textContent = customer.reward;

      // Never show the raw GHL contact ID. Only show the Membership ID row
      // when the customer has a friendly membership identifier of their own.
      const hasFriendlyId =
        Boolean(customer.membershipId) && customer.membershipId !== customer.ghlContactId;
      elements.rowMembershipId.classList.toggle("is-hidden", !hasFriendlyId);
      elements.customerMembershipId.textContent = hasFriendlyId ? customer.membershipId : "";

      const redemptionInfo =
        REDEMPTION_STATE_LABELS[customer.redemptionState] || REDEMPTION_STATE_LABELS.ready;

      elements.customerRedemptionStatus.textContent = redemptionInfo.label;
      elements.customerRedemptionStatus.className = `tag ${redemptionInfo.tagClass}`;

      setRedeemButton(customer.redemptionState === "ready" ? "ready" : "blocked");

      showState("customer");
    }

    /** Redeem button states: ready | blocked | busy */
    function setRedeemButton(mode) {
      const btn = elements.btnRedeem;
      btn.textContent = mode === "busy" ? "Redeeming…" : "Redeem Reward";
      btn.disabled = mode !== "ready";
      btn.style.opacity = mode === "blocked" ? "0.5" : "1";
      btn.style.cursor = mode === "ready" ? "pointer" : "not-allowed";
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

    /** Routes a 401 from any API call back through the login screen. */
    function handleUnauthorized() {
      AuthService.setToken("");
      if (activeCustomer) {
        pendingLookupId = activeCustomer.ghlContactId || activeCustomer.membershipId;
        activeCustomer = null;
      }
      showLogin("Your session has ended. Please sign in again.");
    }

    async function handleLookup(membershipId) {
      if (!membershipId) {
        elements.membershipInput.classList.add("is-invalid");
        elements.membershipInput.focus();
        return;
      }

      elements.membershipInput.classList.remove("is-invalid");
      showState("loading");

      // Show the ID in the input when launched from a QR
      elements.membershipInput.value = membershipId;

      const result = await CustomerService.lookup(membershipId);

      if (result.ok) {
        renderCustomer(result.customer);
      } else if (result.reason === "unauthorized") {
        pendingLookupId = membershipId;
        handleUnauthorized();
      } else {
        renderFailure(result.reason);
      }
    }

    async function handleRedeem() {
      if (!activeCustomer || elements.btnRedeem.disabled) {
        return;
      }

      // Lock the button before the request — no duplicate clicks.
      setRedeemButton("busy");

      const result = await CustomerService.redeem(activeCustomer);

      if (result.ok) {
        renderSuccess(activeCustomer, result.transaction);
        activeCustomer = null;
      } else if (result.reason === "unauthorized") {
        setRedeemButton("ready");
        handleUnauthorized();
      } else {
        setRedeemButton("ready");
        renderFailure(result.reason);
      }
    }

    async function handleLogin(event) {
      event.preventDefault();
      const pin = elements.loginPin.value.trim();
      if (!pin) {
        elements.loginError.textContent = "Please enter your PIN.";
        elements.loginPin.focus();
        return;
      }

      elements.btnSignIn.disabled = true;
      elements.btnSignIn.textContent = "Signing In…";
      elements.loginError.textContent = "";

      const result = await AuthService.login(pin, elements.loginName.value.trim());

      elements.btnSignIn.disabled = false;
      elements.btnSignIn.textContent = "Sign In";
      elements.loginPin.value = "";

      if (result.ok) {
        enterPortal();
      } else {
        elements.loginError.textContent =
          LOGIN_ERROR_MESSAGES[result.reason] || LOGIN_ERROR_MESSAGES.network_error;
        elements.loginPin.focus();
      }
    }

    async function handleLogout() {
      await QrScanner.close();
      await AuthService.logout();
      activeCustomer = null;
      pendingLookupId = "";
      showLogin();
    }

    /** After authentication: run any QR deep link, else show search. */
    function enterPortal() {
      setLoggedInUi(true);
      if (pendingLookupId) {
        const id = pendingLookupId;
        pendingLookupId = "";
        handleLookup(id);
      } else {
        resetToSearch();
      }
    }

    /* --------------------------------------------------------------
     * Camera QR scanner (html5-qrcode, loaded from CDN)
     * ------------------------------------------------------------ */
    const QrScanner = (function () {
      let instance = null;
      let starting = false;

      /**
       * Sizes the scan region as a fraction of the actual camera
       * viewfinder instead of a fixed 220px box. html5-qrcode crops the
       * decode canvas to exactly this region, so a bigger box means more
       * real pixels reach the decoder — important for the production Big
       * Play QR, which has a centered logo and needs more of its
       * surrounding modules in view to error-correct around it.
       */
      function qrboxFunction(viewfinderWidth, viewfinderHeight) {
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const edge = Math.floor(minEdge * 0.75);
        // Keep it sane on very small or very large viewfinders.
        const clamped = Math.max(220, Math.min(edge, 500));
        return { width: clamped, height: clamped };
      }

      /**
       * Accepts either a full QR URL (?contactId= / ?membershipId= / ?id=)
       * or a raw identifier, and returns the ID to look up, or "".
       */
      function extractIdFromQrText(text) {
        const raw = (text || "").trim();
        if (!raw) return "";

        if (/^https?:\/\//i.test(raw)) {
          try {
            const url = new URL(raw);
            return (
              url.searchParams.get("contactId") ||
              url.searchParams.get("membershipId") ||
              url.searchParams.get("id") ||
              ""
            ).trim();
          } catch {
            return "";
          }
        }

        // Raw identifier fallback (membership ID or GHL contact ID).
        return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(raw) ? raw : "";
      }

      function setError(message) {
        elements.scannerError.textContent = message || "";
      }

      async function open() {
        if (typeof window.Html5Qrcode === "undefined") {
          window.alert(
            "The QR scanner could not load on this device.\n" +
              "Please enter the Membership ID manually."
          );
          elements.membershipInput.focus();
          return;
        }
        if (starting || instance) return;

        elements.scannerOverlay.classList.remove("is-hidden");
        setError("");
        starting = true;

        try {
          instance = new window.Html5Qrcode("qrReader");
          await instance.start(
            { facingMode: "environment" },
            {
              fps: 10,
              qrbox: qrboxFunction,
              // Providing videoConstraints replaces the plain facingMode
              // constraint above, so it's repeated here. Requesting a
              // higher-resolution capture (not just a bigger UI box) is
              // what actually gives the decoder more detail to work with
              // on a stylized/logo QR — `ideal` degrades gracefully on
              // devices/cameras that can't hit 1080p. `advanced` focus/
              // exposure hints are best-effort and are simply ignored by
              // browsers that don't support them (never throws).
              videoConstraints: {
                facingMode: "environment",
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                advanced: [{ focusMode: "continuous" }],
              },
            },
            onScanSuccess,
            () => {
              /* Per-frame decode misses are normal — never surface them. */
            }
          );
        } catch (error) {
          instance = null;
          const message = String(error || "");
          if (/NotAllowedError|Permission/i.test(message)) {
            setError(
              "Camera access was denied. Allow camera access in your browser settings, or cancel and enter the ID manually."
            );
          } else if (/NotFoundError|NotReadableError/i.test(message)) {
            setError("No usable camera was found on this device. Cancel and enter the ID manually.");
          } else {
            setError("The camera could not be started. Cancel and enter the ID manually.");
          }
        } finally {
          starting = false;
        }
      }

      async function close() {
        elements.scannerOverlay.classList.add("is-hidden");
        setError("");
        const current = instance;
        instance = null;
        if (current) {
          try {
            await current.stop();
            current.clear();
          } catch {
            /* Camera already stopped. */
          }
        }
      }

      async function onScanSuccess(decodedText) {
        // Stop the camera immediately on a successful read.
        await close();
        const id = extractIdFromQrText(decodedText);
        if (id) {
          handleLookup(id);
        } else {
          renderFailure("not_found");
          elements.failureTitle.textContent = "Invalid QR Code";
          elements.failureMessage.textContent =
            "That QR code isn't a Players Club member code. Try again or enter the ID manually.";
        }
      }

      return { open, close, extractIdFromQrText };
    })();

    function bindEvents() {
      elements.searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        handleLookup(elements.membershipInput.value.trim());
      });

      elements.loginForm.addEventListener("submit", handleLogin);
      elements.btnLogout.addEventListener("click", handleLogout);

      elements.btnScanQr.addEventListener("click", () => QrScanner.open());
      elements.btnCloseScanner.addEventListener("click", () => QrScanner.close());

      elements.btnCancel.addEventListener("click", resetToSearch);
      elements.btnRedeem.addEventListener("click", handleRedeem);
      elements.btnNewRedemption.addEventListener("click", resetToSearch);
      elements.btnTryAgain.addEventListener("click", resetToSearch);

      elements.membershipInput.addEventListener("input", () => {
        elements.membershipInput.classList.remove("is-invalid");
      });

      // Release the camera if the page is navigated away or backgrounded.
      window.addEventListener("pagehide", () => {
        QrScanner.close();
      });
    }

    async function init() {
      bindEvents();

      // Capture a QR deep link (?contactId= / ?membershipId=) up front so
      // it survives the login step. This preserves the existing behavior:
      // an authenticated employee opening a QR URL goes straight to the
      // customer, no manual entry.
      const params = new URLSearchParams(window.location.search);
      const deepLinkId = (params.get("contactId") || params.get("membershipId") || "").trim();
      if (deepLinkId) {
        pendingLookupId = deepLinkId;
        elements.membershipInput.value = deepLinkId;
      }

      showState("loading");
      const session = await AuthService.checkSession();

      if (session.authenticated) {
        enterPortal();
      } else {
        showLogin(session.networkError ? LOGIN_ERROR_MESSAGES.network_error : "");
      }
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
