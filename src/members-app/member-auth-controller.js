import { NAME_KEY, PDGA_KEY, TOKEN_KEY, authBase, request, storageGet } from "./api.js";
import { clearAuthError, setAuthBusy, setAuthFormState, setAuthFormValues, showApplyShell, showAuthError, showEmailShell, showLoginShell, showMembersShell, showPinChangeShell, showResetShell } from "./member-auth-dom.js";
import { applyProfile, markEmailSaved, memberAuthProfile, memberDashboardContext, resetMemberProfile } from "./member-auth-state.js";
import { createPasskeyController, passkeysSupported } from "./member-passkeys.js";
import { createProfileController } from "./member-profile-controller.js";
import { resetPdgaMembershipCache } from "./pdga-membership.js";
import { suppressNextRouterPop } from "./dashboard-router.js";
import { clearMemberSession, memberTokenExpired, memberTokenSubject, writeMemberSessionValue } from "../shared/member-session.js";

let installed = false;
let sessionExpiredShown = false;
// Email can't be sent right now (the Worker has no mail key): don't hold anyone at the email step this visit.
let emailStepUnavailable = false;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
    clearMemberSession();
    resetMemberProfile();
    resetPdgaMembershipCache();
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

  // Screens opened on top of the app (Edit profile, your email, Forgot PIN) get a step in the back history, so a back
  // swipe closes them and returns to where you were instead of leaving the app. One step however many screens deep.
  let overlay = null;
  let skipNextPop = false;
  function openOverlay(kind) {
    try {
      const state = { ...(window.history.state || {}), gvdgAuthOverlay: kind };
      if (overlay) window.history.replaceState(state, "");
      else window.history.pushState(state, "");
    } catch {
      /* history unavailable: the screen still works, back just leaves */
    }
    overlay = kind;
  }
  function closeOverlay() {
    if (!overlay) return;
    overlay = null;
    if (window.history.state?.gvdgAuthOverlay) {
      skipNextPop = true;
      suppressNextRouterPop();
      window.history.back();
    }
  }
  window.addEventListener("popstate", () => {
    if (skipNextPop) {
      skipNextPop = false;
      return;
    }
    if (!overlay) return;
    const kind = overlay;
    overlay = null;
    if (kind === "reset" || kind === "apply") showLogin();
    else showMembersContent(storageGet(NAME_KEY));
  });

  function showLogin() {
    closeOverlay();
    showLoginShell(passkeysSupported());
    if (passkeysSupported()) passkeys.startPasskeyPriming();
  }

  function showPinChange() {
    showPinChangeShell(passkeysSupported());
  }

  function showMembersContent(name) {
    closeOverlay();
    passkeys.stopPasskeyPriming();
    const context = memberDashboardContext();
    // An email is how a forgotten PIN gets reset. Accounts created since it became a requirement add one before going
    // on; everyone from before (and admins) gets a reminder on Home instead (owner: "Let's not block people who are
    // already logged in and have memberships. Just require new users from here on out").
    if (context.emailRequired && !context.isAdmin && !emailStepUnavailable) {
      showEmailSetup(true);
      return;
    }
    showMembersShell(name || context.name || null);
  }

  function showEmailSetup(required) {
    setAuthFormValues("email", { email: "", pin: "", code: "", step: "email", sentTo: "", required, pinNeeded: false });
    showEmailShell(passkeysSupported());
    // Opened from inside the app: back returns to it. (The required step after sign-in has nowhere to go back to.)
    if (!required) openOverlay("email");
  }

  async function handleEmailStart(event) {
    const email = detailString(event, "email").toLowerCase();
    const pin = detailString(event, "pin");
    clearAuthError("email");
    if (!EMAIL_RE.test(email)) {
      showAuthError("email", "Enter a valid email.");
      return;
    }
    const token = storageGet(TOKEN_KEY);
    if (!token) {
      showLogin();
      return;
    }
    setAuthBusy("email", "email", true);
    try {
      const response = await api("/me/email/start", { method: "POST", token, body: pin ? { email, pin } : { email } });
      const data = await response.json().catch(() => ({}));
      if (response.status === 200) {
        setAuthFormValues("email", { step: "code", sentTo: email, email, code: "" });
      } else if (data.error === "pin_required") {
        setAuthFormValues("email", { pinNeeded: true, step: "email" });
        showAuthError("email", passkeysSupported() ? "Enter your PIN, or use your passkey, to confirm it's you." : "Enter your PIN to confirm it's you.");
      } else if (data.error === "wrong_pin") {
        setAuthFormValues("email", { pinNeeded: true, step: "email", pin: "" });
        showAuthError("email", "That PIN didn't match.");
      } else if (data.error === "email_in_use") {
        showAuthError("email", "That email is on another account. Use a different one, or ask a club admin.");
      } else if (data.error === "same_email") {
        showAuthError("email", "That's already your email.");
      } else if (data.error === "invalid_email") {
        showAuthError("email", "Enter a valid email.");
      } else if (data.error === "email_unavailable") {
        emailStepUnavailable = true;
        if (memberAuthProfile().needsEmail) showMembersContent(memberDashboardContext().name);
        else showAuthError("email", "Email isn't available right now. Try again later.");
      } else if (data.error === "email_failed") {
        showAuthError("email", "We couldn't send to that address. Check it and try again.");
      } else if (response.status === 423) {
        showAuthError("email", `Too many tries. Try again in ~${Math.ceil((data.retryAfterSec || 900) / 60)} min.`);
      } else if (response.status === 429) {
        showAuthError("email", "Too many codes sent for now. Try again in up to an hour, or ask a club admin to clear it (Admin › Members › Clear lockouts).");
      } else if (response.status !== 401) {
        showAuthError("email", "Something went wrong. Please try again.");
      }
    } catch {
      showAuthError("email", "Network error. Please check your connection.");
    } finally {
      setAuthBusy("email", "email", false);
    }
  }

  async function handleEmailVerify(event) {
    const code = detailString(event, "code").replace(/\s+/g, "");
    clearAuthError("email");
    if (!/^\d{6}$/.test(code)) {
      showAuthError("email", "Enter the 6-digit code from the email.");
      return;
    }
    const token = storageGet(TOKEN_KEY);
    if (!token) {
      showLogin();
      return;
    }
    setAuthBusy("email", "email", true);
    try {
      const response = await api("/me/email/verify", { method: "POST", token, body: { code } });
      const data = await response.json().catch(() => ({}));
      if (response.status === 200) {
        markEmailSaved(data.email);
        setAuthFormValues("email", { email: "", pin: "", code: "", step: "email", sentTo: "", pinNeeded: false });
        showMembersContent(memberDashboardContext().name);
      } else if (data.error === "invalid_code") {
        showAuthError("email", "That code didn't match. Check the email and try again.");
      } else if (data.error === "code_expired") {
        showAuthError("email", "That code has expired. Send a new one.");
      } else if (data.error === "email_in_use") {
        setAuthFormValues("email", { step: "email", code: "" });
        showAuthError("email", "That email is on another account. Use a different one, or ask a club admin.");
      } else if (response.status !== 401) {
        showAuthError("email", "Something went wrong. Please try again.");
      }
    } catch {
      showAuthError("email", "Network error. Please check your connection.");
    } finally {
      setAuthBusy("email", "email", false);
    }
  }

  // "Use my passkey instead" on the email step: a passkey check gives a fresh session (a recent sign-in needs no PIN),
  // as long as the passkey is for the account that's signed in.
  async function handleEmailPasskey(event) {
    const email = detailString(event, "email");
    clearAuthError("email");
    const current = storageGet(TOKEN_KEY);
    if (!current) {
      showLogin();
      return;
    }
    setAuthBusy("email", "email-passkey", true);
    let data;
    try {
      data = await passkeys.confirmWithPasskey();
    } catch (error) {
      setAuthBusy("email", "email-passkey", false);
      showAuthError("email", error?.name === "NotAllowedError" ? "Passkey check cancelled." : "Passkey check didn't work. Use your PIN instead.");
      return;
    }
    if (!data?.token || memberTokenSubject(data.token) !== memberTokenSubject(current)) {
      setAuthBusy("email", "email-passkey", false);
      showAuthError("email", "That passkey is for a different account.");
      return;
    }
    writeMemberSessionValue(TOKEN_KEY, data.token);
    setAuthFormValues("email", { pinNeeded: false, pin: "" });
    setAuthBusy("email", "email-passkey", false);
    await handleEmailStart({ detail: { email } });
  }

  function openReset(event) {
    const identifier = detailString(event || {}, "identifier");
    setAuthFormValues("reset", { identifier, code: "", newPin: "", confirmPin: "", step: "start" });
    showResetShell(passkeysSupported());
    if (event) openOverlay("reset");
  }

  async function handleResetStart(event) {
    const identifier = detailString(event, "identifier");
    clearAuthError("reset");
    if (!authBase()) {
      showAuthError("reset", "PIN reset is not configured yet - contact an admin.");
      return;
    }
    if (!identifier) {
      showAuthError("reset", "Enter your PDGA #, UDisc username or email.");
      return;
    }
    setAuthBusy("reset", "reset", true);
    try {
      const response = await api("/pin-reset/start", { method: "POST", body: { identifier } });
      if (response.status === 200) setAuthFormValues("reset", { step: "code", identifier, code: "" });
      else if (response.status === 429) showAuthError("reset", "Too many tries. Wait a few minutes and try again.");
      else if (response.status === 503) showAuthError("reset", "PIN reset by email isn't available right now. A club admin can reset your PIN.");
      else showAuthError("reset", "Something went wrong. Please try again.");
    } catch {
      showAuthError("reset", "Network error. Please check your connection.");
    } finally {
      setAuthBusy("reset", "reset", false);
    }
  }

  async function handleResetVerify(event) {
    const identifier = detailString(event, "identifier");
    const code = detailString(event, "code").replace(/\s+/g, "");
    const newPin = detailString(event, "newPin");
    const confirmPin = detailString(event, "confirmPin");
    clearAuthError("reset");
    if (!/^\d{6}$/.test(code)) {
      showAuthError("reset", "Enter the 6-digit code from the email.");
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      showAuthError("reset", "PIN must be exactly 4 digits.");
      return;
    }
    if (newPin !== confirmPin) {
      showAuthError("reset", "PINs do not match.");
      return;
    }
    setAuthBusy("reset", "reset", true);
    try {
      const response = await api("/pin-reset/verify", { method: "POST", body: { identifier, code, newPin } });
      const data = await response.json().catch(() => ({}));
      if (response.status === 200) {
        writeMemberSessionValue(TOKEN_KEY, data.token);
        applyProfile(data);
        setAuthFormValues("reset", { identifier: "", code: "", newPin: "", confirmPin: "", step: "start" });
        setAuthFormValues("login", { identifier: identifier, pin: "" });
        showMembersContent(data.name);
      } else if (data.error === "invalid_code") {
        showAuthError("reset", "That code didn't match. Check the email and try again.");
      } else if (data.error === "code_expired") {
        showAuthError("reset", "That code has expired. Send a new one.");
      } else if (response.status === 429) {
        showAuthError("reset", "Too many tries. Wait a few minutes and try again.");
      } else {
        showAuthError("reset", "Something went wrong. Please try again.");
      }
    } catch {
      showAuthError("reset", "Network error. Please check your connection.");
    } finally {
      setAuthBusy("reset", "reset", false);
    }
  }

  function logout() {
    clearMemberSession();
    resetMemberProfile();
    resetPdgaMembershipCache();
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
      showAuthError("login", "Enter your PDGA #, UDisc or email and your PIN.");
      return;
    }

    setAuthBusy("login", "login", true);
    try {
      const response = await api("/login", { method: "POST", body: { identifier, pin } });
      if (response.status === 200) {
        const data = await response.json();
        writeMemberSessionValue(TOKEN_KEY, data.token);
        applyProfile(data);
        setAuthFormValues("login", { pin: "" });
        if (data.mustChangePin) showPinChange();
        else showMembersContent(data.name);
      } else if (response.status === 423) {
        const data = await response.json().catch(() => ({}));
        const minutes = Math.ceil((data.retryAfterSec || 900) / 60);
        showAuthError("login", `Too many attempts. Try again in ~${minutes} min, use Forgot PIN?, or ask a club admin to clear it.`);
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
        writeMemberSessionValue(TOKEN_KEY, data.token);
        setAuthFormValues("pin", { newPin: "", confirmPin: "" });
        const pdga = memberAuthProfile().pdgaNo || storageGet(PDGA_KEY);
        if (pdga) showMembersContent(data.name || storageGet(NAME_KEY));
        else profile.showProfileSetup();
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

  function openApply(event) {
    showApplyShell(passkeysSupported());
    if (event) openOverlay("apply");
  }

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined" && Notification.permission !== "denied";
  }

  function finishApply() {
    setAuthFormValues("apply", { submitted: null, name: "", pdgaNo: "", udisc: "", email: "", phone: "", kind: "member" });
    showLoginShell(passkeysSupported());
    setAuthFormState("login", { error: "Application sent. After an admin approves you, log in with this PIN." });
  }

  async function handleApply(event) {
    const guest = detailString(event, "kind") === "guest";
    const phone = detailString(event, "phone");
    const name = detailString(event, "name");
    const pdgaNo = detailString(event, "pdgaNo");
    const udisc = detailString(event, "udisc");
    const email = detailString(event, "email");
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
    if (!guest && !pdgaNo && !udisc) {
      showAuthError("apply", "Enter a PDGA # or UDisc username.");
      return;
    }
    if (guest && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      showAuthError("apply", "Enter a valid email. You sign in with it.");
      return;
    }
    const phoneDigits = phone.replace(/\D/g, "");
    const phoneOk = phone.trim().startsWith("+")
      ? phoneDigits.length >= 8 && phoneDigits.length <= 15 && !phoneDigits.startsWith("0")
      : phoneDigits.length >= 10;
    if (guest && !phoneOk) {
      showAuthError("apply", "Enter a valid phone number.");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      showAuthError("apply", "Enter a valid email. It's how you reset a forgotten PIN.");
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
      const response = await api("/membership/apply", { method: "POST", body: { name, pdgaNo, udisc, pin, ...(email ? { email } : {}), ...(guest ? { kind: "guest", phone } : {}) } });
      if (response.status === 201) {
        const data = await response.json().catch(() => ({}));
        setAuthFormValues("apply", { pin: "", confirmPin: "" });
        setAuthFormValues("login", { identifier: pdgaNo || udisc || (guest ? email : ""), pin: "" });
        // Dues checkout / push opt-in are credential-gated server-side: with neither available the flow is unchanged.
        const pushKey = pushSupported() ? data.pushPublicKey : null;
        if (data.payToken && data.application?.id && (data.duesOnline || pushKey)) {
          setAuthFormValues("apply", {
            submitted: {
              id: data.application.id,
              payToken: data.payToken,
              duesOnline: data.duesOnline === true,
              duesCents: Number(data.duesCents) || 1500,
              paypalClientId: data.paypalClientId || null,
              pushPublicKey: pushKey || null,
            },
          });
        } else {
          finishApply();
        }
      } else if (response.status === 409) {
        const data = await response.json().catch(() => ({}));
        if (data.error === "member_exists") showAuthError("apply", "That email, PDGA # or UDisc already has an account. Log in instead.");
        else if (data.error === "already_pending") showAuthError("apply", "We already have an application with that email, PDGA # or UDisc.");
        else showAuthError("apply", "Could not submit that application.");
      } else if (response.status === 400 && ["invalid_email", "email_required"].includes((await response.clone().json().catch(() => ({}))).error)) {
        showAuthError("apply", guest ? "Enter a valid email. You sign in with it." : "Enter a valid email. It's how you reset a forgotten PIN.");
      } else if (response.status === 400 && (await response.clone().json().catch(() => ({}))).error === "invalid_phone") {
        showAuthError("apply", "Enter a valid phone number.");
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
      const hash = String(window.location.hash || "").toLowerCase();
      if (hash === "#apply") openApply();
      else if (hash === "#forgot-pin") openReset();
      else showLogin();
      return;
    }
    try {
      const response = await api("/me", { token });
      if (response.status === 200) {
        const data = await response.json();
        // Once a day /me hands back a fresh 30-day session: active members stay signed in.
        if (typeof data.token === "string" && data.token) writeMemberSessionValue(TOKEN_KEY, data.token);
        applyProfile(data);
        if (data.mustChangePin) showPinChange();
        else showMembersContent(data.name || storageGet(NAME_KEY));
      } else {
        logout();
        if (String(window.location.hash || "").toLowerCase() === "#forgot-pin") openReset();
      }
    } catch {
      const offlineSub = memberTokenSubject(token);
      if (offlineSub && !memberTokenExpired(token)) {
        applyProfile({ sub: offlineSub, name: storageGet(NAME_KEY) || "Member", pdgaNo: storageGet(PDGA_KEY) || null });
        showMembersContent(storageGet(NAME_KEY));
      } else {
        showLogin();
      }
    }
  }

  passkeys = createPasskeyController({ api, showMembersContent, showPinChange });
  profile = createProfileController({ api, showLogin, showMembersContent });

  window.addEventListener("gvdg:member-login-requested", handleLogin);
  window.addEventListener("gvdg:member-apply-open", openApply);
  window.addEventListener("gvdg:member-apply-cancel", showLogin);
  window.addEventListener("gvdg:member-apply-requested", handleApply);
  window.addEventListener("gvdg:member-apply-finish", finishApply);
  window.addEventListener("gvdg:member-pin-change-requested", handleSetPin);
  window.addEventListener("gvdg:member-profile-save-requested", profile.saveProfile);
  window.addEventListener("gvdg:member-profile-skip-requested", () => showMembersContent(storageGet(NAME_KEY)));
  window.addEventListener("gvdg:member-profile-photo-chosen", profile.onPhotoChosen);
  window.addEventListener("gvdg:member-passkey-login-requested", passkeys.loginWithPasskey);
  window.addEventListener("gvdg:member-add-passkey-requested", passkeys.enablePasskey);
  window.addEventListener("gvdg:member-edit-profile-requested", () => {
    profile.showProfileSetup();
    openOverlay("profile");
  });
  window.addEventListener("gvdg:member-logout-requested", logout);
  window.addEventListener("gvdg:member-email-start-requested", handleEmailStart);
  window.addEventListener("gvdg:member-email-verify-requested", handleEmailVerify);
  window.addEventListener("gvdg:member-email-passkey-requested", handleEmailPasskey);
  window.addEventListener("gvdg:member-email-change-requested", () => showEmailSetup(false));
  window.addEventListener("gvdg:member-email-cancel", () => showMembersContent(storageGet(NAME_KEY)));
  window.addEventListener("gvdg:member-reset-open", openReset);
  window.addEventListener("gvdg:member-reset-cancel", showLogin);
  window.addEventListener("gvdg:member-reset-start-requested", handleResetStart);
  window.addEventListener("gvdg:member-reset-verify-requested", handleResetVerify);
  window.addEventListener("gvdg:member-auth-ready", checkSession, { once: true });
}

