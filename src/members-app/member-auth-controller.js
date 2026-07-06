import { NAME_KEY, PDGA_KEY, TOKEN_KEY, authBase, request, storageGet } from "./api.js";
import { byId, clearError, setBusy, showError, showLoginShell, showMembersShell, showPinChangeShell } from "./member-auth-dom.js";
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
    showError(byId("loginError"), "Your session expired - please sign in again.");
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
    const pinInput = byId("pinInput");
    if (pinInput) pinInput.value = "";
    showLogin();
  }

  async function handleLogin() {
    const identifier = byId("identifierInput")?.value.trim() || "";
    const pin = byId("pinInput")?.value.trim() || "";
    const errorElement = byId("loginError");
    clearError(errorElement);
    if (!authBase()) {
      showError(errorElement, "Login is not configured yet - contact an admin.");
      return;
    }
    if (!identifier || !pin) {
      showError(errorElement, "Enter your PDGA #/UDisc and PIN.");
      return;
    }

    const button = byId("loginBtn");
    setBusy(button, true);
    try {
      const response = await api("/login", { method: "POST", body: { identifier, pin } });
      if (response.status === 200) {
        const data = await response.json();
        storageSet(TOKEN_KEY, data.token);
        applyProfile(data);
        const pinInput = byId("pinInput");
        if (pinInput) pinInput.value = "";
        if (data.mustChangePin) showPinChange();
        else showMembersContent(data.name);
      } else if (response.status === 423) {
        const data = await response.json().catch(() => ({}));
        const minutes = Math.ceil((data.retryAfterSec || 900) / 60);
        showError(errorElement, `Too many attempts. Try again in ~${minutes} min.`);
      } else if (response.status === 401) {
        showError(errorElement, "Invalid PDGA #/UDisc or PIN.");
      } else {
        showError(errorElement, "Something went wrong. Please try again.");
      }
    } catch {
      showError(errorElement, "Network error. Please check your connection.");
    } finally {
      setBusy(button, false);
    }
  }

  async function handleSetPin() {
    const newPin = byId("newPinInput")?.value.trim() || "";
    const confirmPin = byId("confirmPinInput")?.value.trim() || "";
    const errorElement = byId("pinChangeError");
    clearError(errorElement);
    if (!/^\d{4}$/.test(newPin)) {
      showError(errorElement, "PIN must be exactly 4 digits.");
      return;
    }
    if (newPin !== confirmPin) {
      showError(errorElement, "PINs do not match.");
      return;
    }

    const token = storageGet(TOKEN_KEY);
    if (!token) {
      showLogin();
      return;
    }

    const button = byId("setPinBtn");
    setBusy(button, true);
    try {
      const response = await api("/set-pin", { method: "POST", token, body: { newPin } });
      if (response.status === 200) {
        const data = await response.json();
        storageSet(TOKEN_KEY, data.token);
        const newPinInput = byId("newPinInput");
        const confirmPinInput = byId("confirmPinInput");
        if (newPinInput) newPinInput.value = "";
        if (confirmPinInput) confirmPinInput.value = "";
        profile.showProfileSetup();
      } else if (response.status === 401) {
        showLogin();
      } else {
        showError(errorElement, "Could not update PIN. Please try again.");
      }
    } catch {
      showError(errorElement, "Network error. Please try again.");
    } finally {
      setBusy(button, false);
    }
  }

  async function checkSession() {
    const token = storageGet(TOKEN_KEY);
    if (!token || !authBase()) {
      showLogin();
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
