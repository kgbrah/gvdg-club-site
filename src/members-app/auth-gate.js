import React from "react";
import { Camera, KeyRound, LockKeyhole } from "lucide-react";

const h = React.createElement;
const SHELL_EVENT = "gvdg:member-shell-view";
const PROFILE_PREVIEW_EVENT = "gvdg:member-profile-preview";

function request(eventName, detail = {}) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

function FormGroup({ label, htmlFor, hint, children }) {
  return h("div", { className: "form-group" }, [
    h("label", { className: "form-label", htmlFor, key: "label" }, label),
    children,
    hint ? h("p", { className: "form-hint", key: "hint" }, hint) : null,
  ]);
}

function AuthIcon() {
  return h("div", { className: "login-icon", "aria-hidden": "true" }, h(LockKeyhole, { size: 56, strokeWidth: 1.8 }));
}

function IconLabel({ icon, text }) {
  return h("span", { className: "auth-icon-label" }, [icon, h("span", { key: "text" }, text)]);
}

function LoginForm({ active, supportsPasskeys }) {
  return h("form", {
    className: "login-form",
    id: "loginForm",
    autoComplete: "on",
    hidden: !active,
    onSubmit: (event) => {
      event.preventDefault();
      request("gvdg:member-login-requested");
    },
  }, [
    h(FormGroup, {
      label: "PDGA # or UDisc Username",
      htmlFor: "identifierInput",
      hint: "Whichever you registered with the club",
      key: "identifier",
    }, h("input", {
      type: "text",
      className: "form-input",
      id: "identifierInput",
      name: "identifier",
      autoComplete: "username",
      placeholder: "12345 or UDisc handle",
    })),
    h(FormGroup, {
      label: "PIN",
      htmlFor: "pinInput",
      hint: "New members: use the temporary PIN from an admin",
      key: "pin",
    }, h("input", {
      type: "password",
      className: "form-input",
      id: "pinInput",
      name: "pin",
      inputMode: "numeric",
      autoComplete: "current-password",
      maxLength: 4,
      placeholder: "4-digit PIN",
    })),
    h("button", { type: "submit", className: "login-btn", id: "loginBtn", key: "login" }, "Log In"),
    h("div", { className: "login-error", id: "loginError", key: "error" }),
    supportsPasskeys ? h("div", { className: "login-divider", key: "divider" }, h("span", null, "or")) : null,
    supportsPasskeys
      ? h("button", {
        type: "button",
        className: "login-btn login-btn-secondary",
        id: "passkeyBtn",
        onClick: () => request("gvdg:member-passkey-login-requested"),
        key: "passkey",
      }, h(IconLabel, { icon: h(KeyRound, { size: 17, strokeWidth: 2.2, key: "icon" }), text: "Log in with a passkey" }))
      : null,
  ].filter(Boolean));
}

function PinChangeForm({ active }) {
  return h("form", {
    className: "login-form",
    id: "pinChangeForm",
    autoComplete: "on",
    hidden: !active,
    onSubmit: (event) => {
      event.preventDefault();
      request("gvdg:member-pin-change-requested");
    },
  }, [
    h("p", { className: "login-subtitle", key: "copy" }, "You're using a temporary PIN. Choose your own to continue."),
    h(FormGroup, { label: "New PIN", htmlFor: "newPinInput", key: "new-pin" }, h("input", {
      type: "password",
      className: "form-input",
      id: "newPinInput",
      name: "new-pin",
      inputMode: "numeric",
      autoComplete: "new-password",
      maxLength: 4,
      placeholder: "Choose a 4-digit PIN",
    })),
    h(FormGroup, { label: "Confirm PIN", htmlFor: "confirmPinInput", key: "confirm-pin" }, h("input", {
      type: "password",
      className: "form-input",
      id: "confirmPinInput",
      name: "confirm-pin",
      inputMode: "numeric",
      autoComplete: "new-password",
      maxLength: 4,
      placeholder: "Re-enter your PIN",
    })),
    h("button", { type: "submit", className: "login-btn", id: "setPinBtn", key: "save" }, "Save PIN & Continue"),
    h("div", { className: "login-error", id: "pinChangeError", key: "error" }),
  ]);
}

function ProfileForm({ active }) {
  const [previewSrc, setPreviewSrc] = React.useState("");

  React.useEffect(() => {
    function update(event) {
      setPreviewSrc(typeof event.detail?.src === "string" ? event.detail.src : "");
    }

    window.addEventListener(PROFILE_PREVIEW_EVENT, update);
    return () => window.removeEventListener(PROFILE_PREVIEW_EVENT, update);
  }, []);

  return h("form", {
    className: "login-form",
    id: "profileForm",
    autoComplete: "on",
    hidden: !active,
    onSubmit: (event) => {
      event.preventDefault();
      request("gvdg:member-profile-save-requested");
    },
  }, [
    h("p", { className: "login-subtitle", key: "copy" }, "Add your details so your ratings, stats and photo show up. All optional - you can do this later."),
    h("div", { className: "profile-photo-row", key: "photo" }, [
      h("img", { className: "profile-photo-preview", "data-react-profile-preview": previewSrc ? "ready" : "empty", src: previewSrc || undefined, hidden: !previewSrc, alt: "Profile photo preview", key: "preview" }),
      h("label", { className: "passkey-btn", htmlFor: "photoInput", key: "label" }, h(IconLabel, {
        icon: h(Camera, { size: 17, strokeWidth: 2.2, key: "icon" }),
        text: "Add / change photo",
      })),
      h("input", {
        type: "file",
        id: "photoInput",
        accept: "image/png,image/jpeg,image/webp",
        hidden: true,
        onChange: (event) => request("gvdg:member-profile-photo-chosen", { files: event.target.files }),
        key: "input",
      }),
    ]),
    h(FormGroup, { label: "PDGA # (optional)", htmlFor: "profilePdgaInput", key: "pdga" }, h("input", {
      type: "text",
      className: "form-input",
      id: "profilePdgaInput",
      inputMode: "numeric",
      placeholder: "e.g. 167210",
    })),
    h(FormGroup, { label: "UDisc username (optional)", htmlFor: "profileUdiscInput", key: "udisc" }, h("input", {
      type: "text",
      className: "form-input",
      id: "profileUdiscInput",
      placeholder: "your UDisc handle",
    })),
    h("button", { type: "submit", className: "login-btn", id: "profileSaveBtn", key: "save" }, "Save & Continue"),
    h("button", {
      type: "button",
      className: "login-btn login-btn-secondary",
      id: "profileSkipBtn",
      onClick: () => request("gvdg:member-profile-skip-requested"),
      key: "skip",
    }, "Skip for now"),
    h("div", { className: "login-error", id: "profileError", key: "error" }),
  ]);
}

export function MemberAuthGate() {
  const [mode, setMode] = React.useState("login");
  const [shellView, setShellView] = React.useState("auth");
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);

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
    window.dispatchEvent(new CustomEvent("gvdg:member-auth-ready", { detail: { mode: "login", passkeysSupported: supported } }));
  }, []);

  React.useEffect(() => {
    function update(event) {
      const nextMode = event.detail?.mode;
      setMode(nextMode === "pin" || nextMode === "profile" ? nextMode : "login");
      setShellView("auth");
      if (typeof event.detail?.passkeysSupported === "boolean") setSupportsPasskeys(event.detail.passkeysSupported);
    }

    window.addEventListener("gvdg:member-auth-mode", update);
    return () => window.removeEventListener("gvdg:member-auth-mode", update);
  }, []);

  React.useEffect(() => {
    function updateShell(event) {
      setShellView(event.detail?.view === "members" ? "members" : "auth");
    }

    window.addEventListener(SHELL_EVENT, updateShell);
    return () => window.removeEventListener(SHELL_EVENT, updateShell);
  }, []);

  return h("div", { className: "login-card", "data-react-auth-gate": mode }, [
    h(AuthIcon, { key: "icon" }),
    h("h1", { className: "login-title", key: "title" }, "Members Only"),
    h("p", { className: "login-subtitle", key: "subtitle" }, "Log in with your PDGA # or UDisc username and your PIN."),
    h(LoginForm, { active: mode === "login", supportsPasskeys, key: "login" }),
    h(PinChangeForm, { active: mode === "pin", key: "pin" }),
    h(ProfileForm, { active: mode === "profile", key: "profile" }),
    h("a", { href: "index.html", className: "back-link", key: "back" }, "Back to main site"),
  ]);
}
