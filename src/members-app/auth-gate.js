import React from "react";
import { ApplyForm, AuthIcon, EmailForm, LoginForm, PinChangeForm, ProfileForm, ResetPinForm } from "./auth-forms.js";

const h = React.createElement;
const SHELL_EVENT = "gvdg:member-shell-view";
const AUTH_FORM_STATE_EVENT = "gvdg:member-auth-form-state";
const AUTH_FORMS = new Set(["login", "pin", "profile", "apply", "email", "reset"]);
const AUTH_MODES = new Set(["login", "pin", "profile", "apply", "email", "reset"]);

function initialAuthMode() {
  const hash = String(window.location.hash || "").toLowerCase();
  return hash === "#apply" ? "apply" : hash === "#forgot-pin" ? "reset" : "login";
}

const FORM_VALUES = {
  login: { identifier: "", pin: "" },
  pin: { newPin: "", confirmPin: "" },
  profile: { pdga: "", udisc: "" },
  apply: { name: "", pdgaNo: "", udisc: "", email: "", pin: "", confirmPin: "", submitted: null },
  email: { email: "", pin: "", code: "", step: "email", sentTo: "", required: true, pinNeeded: false },
  reset: { identifier: "", code: "", newPin: "", confirmPin: "", step: "start" },
};

function createFormState(form) {
  return { error: "", busyAction: "", values: FORM_VALUES[form] };
}

function mergeFormState(previous, form, changes) {
  const detailValues = changes.values && typeof changes.values === "object" ? changes.values : null;
  return {
    ...previous,
    [form]: {
      error: typeof changes.error === "string" ? changes.error : previous[form].error,
      busyAction: typeof changes.busyAction === "string" ? changes.busyAction : previous[form].busyAction,
      values: detailValues ? { ...previous[form].values, ...detailValues } : previous[form].values,
    },
  };
}

export function MemberAuthGate() {
  const [mode, setMode] = React.useState(initialAuthMode);
  const [shellView, setShellView] = React.useState("auth");
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [formStates, setFormStates] = React.useState({
    login: createFormState("login"),
    pin: createFormState("pin"),
    profile: createFormState("profile"),
    apply: createFormState("apply"),
    email: createFormState("email"),
    reset: createFormState("reset"),
  });

  function setFormValues(form, values) {
    if (AUTH_FORMS.has(form)) setFormStates((previous) => mergeFormState(previous, form, { values }));
  }

  React.useEffect(() => {
    document.body.dataset.memberShell = shellView;
    return () => {
      if (document.body.dataset.memberShell === shellView) delete document.body.dataset.memberShell;
    };
  }, [shellView]);

  React.useEffect(() => {
    if (shellView !== "auth") return undefined;
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
    return () => window.cancelAnimationFrame(frame);
  }, [mode, shellView]);

  React.useEffect(() => {
    const supported = typeof window.PublicKeyCredential !== "undefined";
    setSupportsPasskeys(supported);

    function update(event) {
      const nextMode = event.detail?.mode;
      setMode(AUTH_MODES.has(nextMode) ? nextMode : "login");
      setShellView("auth");
      if (typeof event.detail?.passkeysSupported === "boolean") setSupportsPasskeys(event.detail.passkeysSupported);
    }

    // Listen before ready: checkSession may dispatch apply mode on the same tick as #apply.
    window.addEventListener("gvdg:member-auth-mode", update);
    window.dispatchEvent(new CustomEvent("gvdg:member-auth-ready", { detail: { mode: initialAuthMode(), passkeysSupported: supported } }));
    return () => window.removeEventListener("gvdg:member-auth-mode", update);
  }, []);

  React.useEffect(() => {
    function update(event) {
      const form = event.detail?.form;
      if (!AUTH_FORMS.has(form)) return;
      setFormStates((previous) => mergeFormState(previous, form, event.detail || {}));
    }

    window.addEventListener(AUTH_FORM_STATE_EVENT, update);
    return () => window.removeEventListener(AUTH_FORM_STATE_EVENT, update);
  }, []);

  React.useEffect(() => {
    function updateShell(event) {
      setShellView(event.detail?.view === "members" ? "members" : "auth");
    }

    window.addEventListener(SHELL_EVENT, updateShell);
    return () => window.removeEventListener(SHELL_EVENT, updateShell);
  }, []);

  const titles = {
    login: "Members Only", apply: "Join the Club", pin: "Choose a PIN", profile: "Edit profile",
    email: formStates.email.values.required ? "Add your email" : "Your email", reset: "Reset your PIN",
  };
  return h("div", { className: "login-card", "data-react-auth-gate": mode }, [
    h(AuthIcon, { mode, key: "icon" }),
    h("h1", { className: "login-title", key: "title" }, titles[mode]),
    mode === "login" ? h("p", { className: "login-subtitle", key: "subtitle" }, "Sign in with the details you registered with the club.") : null,
    h(LoginForm, { active: mode === "login", supportsPasskeys, state: formStates.login, onValuesChange: setFormValues, key: "login" }),
    h(ApplyForm, { active: mode === "apply", state: formStates.apply, onValuesChange: setFormValues, key: "apply" }),
    h(PinChangeForm, { active: mode === "pin", state: formStates.pin, onValuesChange: setFormValues, key: "pin" }),
    h(ProfileForm, { active: mode === "profile", state: formStates.profile, onValuesChange: setFormValues, key: "profile" }),
    // Mounted only while showing, so their fields never duplicate the sign-in form's labels or autofill targets.
    mode === "email" ? h(EmailForm, { active: true, state: formStates.email, onValuesChange: setFormValues, key: "email" }) : null,
    mode === "reset" ? h(ResetPinForm, { active: true, state: formStates.reset, onValuesChange: setFormValues, key: "reset" }) : null,
    mode === "login" ? h("div", { className: "member-auth-alternate", key: "play" }, [
      h("p", { className: "login-subtitle", key: "hint" }, "Casual scoring is open to everyone."),
      h("a", { className: "dashboard-action", href: "score.html", key: "start" }, "Start a round"),
    ]) : null,
    h("a", { href: "index.html", className: "back-link", key: "back" }, "Back to main site"),
  ]);
}
