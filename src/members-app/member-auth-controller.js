import { NAME_KEY, PDGA_KEY, TOKEN_KEY, authBase, request, storageGet } from "./api.js";
import { clearAuthError, setAuthBusy, setAuthFormState, setAuthFormValues, showApplyShell, showAuthError, showLoginShell, showMembersShell, showPinChangeShell } from "./member-auth-dom.js";
import { applyProfile, memberDashboardContext, resetMemberProfile } from "./member-auth-state.js";
import { createPasskeyController, passkeysSupported } from "./member-passkeys.js";
import { createProfileController } from "./member-profile-controller.js";

let installed = false;
let sessionExpiredShown = false;

function storageRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
  }
}

function storageSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
  }
}

function detailString(event, key) {
  const value = event.detail?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function installMemberAuthController() {
  if (installed) return;
  installed = true;

  let passkeys;
  let profile;

  function handleSessionExpired() {
    if (sessionExpiredShown) return;
    sessionExpiredShown = true;
    storageRemove(TOKEN_KEY);
    showLogin();
    showAuthError("login", "Your session expired - please sign in again.");
    setTimeout(() => {
      sessionExpiredShown = false;
    }, 4000);
  }

  async function api(path, options = {}) {
    const response = await request(path, options);
    if (response.status === 401 && options.token) handleSessionExpired();
    return response;
  }

  function showLogin() {
    showLoginShell(passkeysSupported());
    if (passkeysSupported()) passkeys.startPasskeyPriming();
  }

  function showPinChange() {
    showPinChangeShell(passkeysSupported());
  }

  function showMembersContent(name) {
    passkeys.stopPasskeyPriming();
    const context = memberDashboardContext();
    showMembersShell(name || context.name || null);
  }

  function logout() {
    storageRemove(TOKEN_KEY);
    storageRemove(NAME_KEY);
    storageRemove(PDGA_KEY);
    resetMemberProfile();
    setAuthFormValues("login", { pin: "" });
    showLogin();
  }

  async function handleLogin(event) {
    const identifier = detailString(event, "identifier");
    const pin = detailString(event, "pin");
    clearAuthError("login");
    if (!authBase()) {
      showAuthError("login", "Login is not configured yet - contact an admin.");
      return;
    }
    if (!identifier || !pin) {
      showAuthError("login", "Enter your PDGA #/UDisc and PIN.");
      return;
    }

    setAuthBusy("login", "login", true);
    try {
      const response = await api("/login", { method: "POST", body: { identifier, pin } });
      if (response.status === 200) {
        const data = await response.json();
        storageSet(TOKEN_KEY, data.token);
        applyProfile(data);
        setAuthFormValues("login", { pin: "" });
        if (data.mustChangePin) showPinChange();
        else showMembersContent(data.name);
      } else if (response.status === 423) {
        const data = await response.json().catch(() => ({}));
        const minutes = Math.ceil((data.retryAfterSec || 900) / 60);
        showAuthError("login", `Too many attempts. Try again in ~${minutes} min.`);
      } else if (response.status === 401) {
        showAuthError("login", "Invalid PDGA #/UDisc or PIN.");
      } else {
        showAuthError("login", "Something went wrong. Please try again.");
      }
    } catch {
      showAuthError("login", "Network error. Please check your connection.");
    } finally {
      setAuthBusy("login", "login", false);
    }
  }

  async function handleSetPin(event) {
    const newPin = detailString(event, "newPin");
    const confirmPin = detailString(event, "confirmPin");
    clearAuthError("pin");
    if (!/^\d{4}$/.test(newPin)) {
      showAuthError("pin", "PIN must be exactly 4 digits.");
      return;
    }
    if (newPin !== confirmPin) {
      showAuthError("pin", "PINs do not match.");
      return;
    }

    const token = storageGet(TOKEN_KEY);
    if (!token) {
      showLogin();
      return;
    }

    setAuthBusy("pin", "pin", true);
    try {
      const response = await api("/set-pin", { method: "POST", token, body: { newPin } });
      if (response.status === 200) {
        const data = await response.json();
        storageSet(TOKEN_KEY, data.token);
        setAuthFormValues("pin", { newPin: "", confirmPin: "" });
        profile.showProfileSetup();
      } else if (response.status === 401) {
        showLogin();
      } else {
        showAuthError("pin", "Could not update PIN. Please try again.");
      }
    } catch {
      showAuthError("pin", "Network error. Please try again.");
    } finally {
      setAuthBusy("pin", "pin", false);
    }
  }

  function openApply() {
    showApplyShell(passkeysSupported());
  }

  async function handleApply(event) {
    const name = detailString(event, "name");
    const pdgaNo = detailString(event, "pdgaNo");
    const udisc = detailString(event, "udisc");
    const pin = detailString(event, "pin");
    const confirmPin = detailString(event, "confirmPin");
    clearAuthError("apply");
    if (!authBase()) {
      showAuthError("apply", "Membership apply is not configured yet - contact an admin.");
      return;
    }
    if (!name) {
      showAuthError("apply", "Enter your name.");
      return;
    }
    if (!pdgaNo && !udisc) {
      showAuthError("apply", "Enter a PDGA # or UDisc username.");
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      showAuthError("apply", "PIN must be exactly 4 digits.");
      return;
    }
    if (pin !== confirmPin) {
      showAuthError("apply", "PINs do not match.");
      return;
    }

    setAuthBusy("apply", "apply", true);
    try {
      const response = await api("/membership/apply", { method: "POST", body: { name, pdgaNo, udisc, pin } });
      if (response.status === 201) {
        setAuthFormValues("apply", { pin: "", confirmPin: "" });
        setAuthFormValues("login", { identifier: pdgaNo || udisc, pin: "" });
        showLoginShell(passkeysSupported());
        setAuthFormState("login", { error: "Application sent. After an admin approves you, log in with this PIN." });
      } else if (response.status === 409) {
        const data = await response.json().catch(() => ({}));
        if (data.error === "member_exists") showAuthError("apply", "That PDGA # or UDisc is already on the roster. Log in instead.");
        else if (data.error === "already_pending") showAuthError("apply", "We already have an application for that PDGA # or UDisc.");
        else showAuthError("apply", "Could not submit that application.");
      } else if (response.status === 429) {
        showAuthError("apply", "Too many tries. Wait a bit and try again.");
      } else {
        showAuthError("apply", "Could not submit that application. Check the details and try again.");
      }
    } catch {
      showAuthError("apply", "Network error. Please check your connection.");
    } finally {
      setAuthBusy("apply", "apply", false);
    }
  }

  async function checkSession() {
    const token = storageGet(TOKEN_KEY);
    if (!token || !authBase()) {
      if (String(window.location.hash || "").toLowerCase() === "#apply") openApply();
      else showLogin();
      return;
    }
    try {
      const response = await api("/me", { token });
      if (response.status === 200) {
        const data = await response.json();
        applyProfile(data);
        if (data.mustChangePin) showPinChange();
        else showMembersContent(data.name || storageGet(NAME_KEY));
      } else {
        logout();
      }
    } catch {
      showLogin();
    }
  }

  passkeys = createPasskeyController({ api, showMembersContent, showPinChange });
  profile = createProfileController({ api, showLogin, showMembersContent });

  window.addEventListener("gvdg:member-login-requested", handleLogin);
  window.addEventListener("gvdg:member-apply-open", openApply);
  window.addEventListener("gvdg:member-apply-cancel", showLogin);
  window.addEventListener("gvdg:member-apply-requested", handleApply);
  window.addEventListener("gvdg:member-pin-change-requested", handleSetPin);
  window.addEventListener("gvdg:member-profile-save-requested", profile.saveProfile);
  window.addEventListener("gvdg:member-profile-skip-requested", () => showMembersContent(storageGet(NAME_KEY)));
  window.addEventListener("gvdg:member-profile-photo-chosen", profile.onPhotoChosen);
  window.addEventListener("gvdg:member-passkey-login-requested", passkeys.loginWithPasskey);
  window.addEventListener("gvdg:member-add-passkey-requested", passkeys.enablePasskey);
  window.addEventListener("gvdg:member-edit-profile-requested", profile.showProfileSetup);
  window.addEventListener("gvdg:member-logout-requested", logout);
  window.addEventListener("gvdg:member-auth-ready", checkSession, { once: true });
}
