import React from "react";
import { Camera, KeyRound, LockKeyhole, Mail, UserRound } from "lucide-react";
import { ApplySubmitted } from "./apply-submitted.js";
import { requestJson } from "./api.js";
import { useMemberContext } from "./member-context.js";

const h = React.createElement;

function request(eventName, detail = {}) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

function FormGroup({ label, htmlFor, hint, children }) {
  return h("div", { className: "form-group" }, [
    h("label", { className: "form-label", htmlFor, key: "label" }, label),
    React.cloneElement(children, { ...(hint ? { "aria-describedby": htmlFor + "Hint" } : {}), key: "input" }),
    hint ? h("p", { className: "form-hint", id: htmlFor + "Hint", key: "hint" }, hint) : null,
  ]);
}

export function AuthIcon({ mode }) {
  const Icon = mode === "profile" ? UserRound : mode === "pin" || mode === "reset" ? KeyRound : mode === "email" ? Mail : LockKeyhole;
  return h("div", { className: "login-icon", "aria-hidden": "true" }, h(Icon, { size: 28, strokeWidth: 1.8 }));
}

function IconLabel({ icon, text }) {
  return h("span", { className: "auth-icon-label" }, [icon, h("span", { key: "text" }, text)]);
}

function ErrorMessage({ form, state }) {
  return h("div", {
    className: `login-error${state.error ? " show" : ""}`,
    "data-react-auth-error": form,
    "data-react-auth-error-state": state.error ? "shown" : "empty",
    role: state.error ? "alert" : undefined,
    "aria-live": "polite",
  }, state.error);
}

export function LoginForm({ active, supportsPasskeys, state, onValuesChange }) {
  const identifier = state.values.identifier || "";
  const pin = state.values.pin || "";
  const busy = Boolean(state.busyAction);
  const loginBusy = state.busyAction === "login";
  const passkeyBusy = state.busyAction === "passkey";

  return h("form", {
    className: "login-form",
    id: "loginForm",
    autoComplete: "on",
    hidden: !active,
    onSubmit: (event) => {
      event.preventDefault();
      request("gvdg:member-login-requested", { identifier, pin });
    },
  }, [
    h(FormGroup, {
      label: "PDGA #, UDisc username or email",
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
      value: identifier,
      onChange: (event) => onValuesChange("login", { identifier: event.target.value }),
    })),
    h(FormGroup, {
      label: "PIN",
      htmlFor: "pinInput",
      hint: "New? Use the PIN you chose when you applied, or the temporary one from an admin",
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
      value: pin,
      onChange: (event) => onValuesChange("login", { pin: event.target.value }),
    })),
    h("button", { type: "submit", className: "login-btn", disabled: busy, "data-react-auth-action": "login", key: "login" }, loginBusy ? "Please wait…" : "Log In"),
    h(ErrorMessage, { form: "login", state, key: "error" }),
    h("button", {
      type: "button",
      className: "login-forgot",
      disabled: busy,
      "data-react-auth-action": "reset-open",
      onClick: () => request("gvdg:member-reset-open", { identifier }),
      key: "forgot",
    }, "Forgot PIN?"),
    supportsPasskeys ? h("div", { className: "login-divider", key: "divider" }, h("span", null, "or")) : null,
    supportsPasskeys
      ? h("button", {
        type: "button",
        className: "login-btn login-btn-secondary",
        disabled: busy,
        "data-react-auth-action": "passkey",
        onClick: () => request("gvdg:member-passkey-login-requested"),
        key: "passkey",
      }, passkeyBusy ? "Please wait…" : h(IconLabel, { icon: h(KeyRound, { size: 17, strokeWidth: 2.2, key: "icon" }), text: "Log in with a passkey" }))
      : null,
    h("button", {
      type: "button",
      className: "login-btn login-btn-secondary",
      disabled: busy,
      "data-react-auth-action": "apply-open",
      onClick: () => request("gvdg:member-apply-open"),
      key: "apply",
    }, "Apply for a club login"),
  ].filter(Boolean));
}

/** Guest accounts are a promotion for the first 100: how many spots are left (null while loading or offline). */
function useGuestSpots(enabled) {
  const [spots, setSpots] = React.useState(null);
  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    requestJson("/membership/guest-spots", { signal: controller.signal }).then((data) => {
      if (Number.isInteger(data?.left) && Number.isInteger(data?.limit)) setSpots({ left: data.left, limit: data.limit });
    }).catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return spots;
}

export function guestSpotsText(spots) {
  if (!spots) return "Free for the first 100 players: sign up for events, keep score, post in Lost & Found and buy in the marketplace.";
  if (spots.left > 0) {
    return `Free promotion: ${spots.left} of ${spots.limit} guest spots left, with round history and stats included. Sign up for events, keep score, post in Lost & Found and buy in the marketplace.`;
  }
  return `All ${spots.limit} promotional guest spots are taken. A guest account still lets you sign up for events, keep score, post in Lost & Found and buy in the marketplace; round history and stats come with a club membership.`;
}

export function ApplyForm({ active, state, onValuesChange }) {
  const kind = state.values.kind === "guest" ? "guest" : "member";
  const guest = kind === "guest";
  const phone = state.values.phone || "";
  const spots = useGuestSpots(active && guest);
  const name = state.values.name || "";
  const pdgaNo = state.values.pdgaNo || "";
  const udisc = state.values.udisc || "";
  const pin = state.values.pin || "";
  const confirmPin = state.values.confirmPin || "";
  const email = state.values.email || "";
  const submitted = state.values.submitted || null;
  const busy = state.busyAction === "apply";

  if (submitted) return h(ApplySubmitted, { active, info: submitted });

  return h("form", {
    className: "login-form",
    id: "applyForm",
    autoComplete: "on",
    hidden: !active,
    onSubmit: (event) => {
      event.preventDefault();
      request("gvdg:member-apply-requested", { kind, name, pdgaNo, udisc, pin, confirmPin, email, phone });
    },
  }, [
    h("div", { className: "auth-kind", "data-apply-kind": kind, key: "kind", role: "radiogroup", "aria-label": "Account type" }, [
      ["member", "Club member"], ["guest", "Guest account"],
    ].map(([value, label]) => h("button", {
      "aria-checked": String(kind === value), key: value, onClick: () => onValuesChange("apply", { kind: value }), role: "radio", type: "button",
    }, label))),
    h("p", { className: "login-subtitle", key: "copy" }, guest
      ? guestSpotsText(spots) + " An admin approves you, then you sign in with your email and PIN."
      : "Pick a PDGA # or UDisc name and a PIN. An admin approves you, then you can log in."),
    h(FormGroup, { label: "Name", htmlFor: "applyNameInput", key: "name" }, h("input", {
      type: "text",
      className: "form-input",
      id: "applyNameInput",
      name: "name",
      autoComplete: "name",
      maxLength: 80,
      value: name,
      onChange: (event) => onValuesChange("apply", { name: event.target.value }),
    })),
    h(FormGroup, { label: guest ? "PDGA # (optional)" : "PDGA #", htmlFor: "applyPdgaInput", hint: guest ? undefined : "Need PDGA # or UDisc", key: "pdga" }, h("input", {
      type: "text",
      className: "form-input",
      id: "applyPdgaInput",
      inputMode: "numeric",
      maxLength: 12,
      value: pdgaNo,
      onChange: (event) => onValuesChange("apply", { pdgaNo: event.target.value }),
    })),
    h(FormGroup, { label: guest ? "UDisc username (optional)" : "UDisc username", htmlFor: "applyUdiscInput", key: "udisc" }, h("input", {
      type: "text",
      className: "form-input",
      id: "applyUdiscInput",
      maxLength: 50,
      value: udisc,
      onChange: (event) => onValuesChange("apply", { udisc: event.target.value }),
    })),
    h(FormGroup, {
      label: "Email", htmlFor: "applyEmailInput", key: "email",
      hint: guest ? "You sign in with it, and it's how you reset a forgotten PIN. Never shown publicly." : "It's how you reset a forgotten PIN yourself. Never shown publicly.",
    }, h("input", {
      type: "email",
      className: "form-input",
      id: "applyEmailInput",
      name: "email",
      autoComplete: "email",
      maxLength: 120,
      required: true,
      value: email,
      onChange: (event) => onValuesChange("apply", { email: event.target.value }),
    })),
    guest ? h(FormGroup, { label: "Phone", htmlFor: "applyPhoneInput", hint: "So the club can reach you. Never shown publicly.", key: "phone" }, h("input", {
      type: "tel",
      className: "form-input",
      id: "applyPhoneInput",
      name: "tel",
      autoComplete: "tel",
      inputMode: "tel",
      maxLength: 32,
      required: true,
      value: phone,
      onChange: (event) => onValuesChange("apply", { phone: event.target.value }),
    })) : null,
    h(FormGroup, { label: "Choose a PIN", htmlFor: "applyPinInput", key: "pin" }, h("input", {
      type: "password",
      className: "form-input",
      id: "applyPinInput",
      inputMode: "numeric",
      autoComplete: "new-password",
      maxLength: 4,
      value: pin,
      onChange: (event) => onValuesChange("apply", { pin: event.target.value }),
    })),
    h(FormGroup, { label: "Confirm PIN", htmlFor: "applyConfirmPinInput", key: "confirm" }, h("input", {
      type: "password",
      className: "form-input",
      id: "applyConfirmPinInput",
      inputMode: "numeric",
      autoComplete: "new-password",
      maxLength: 4,
      value: confirmPin,
      onChange: (event) => onValuesChange("apply", { confirmPin: event.target.value }),
    })),
    h("button", { type: "submit", className: "login-btn", disabled: busy, "data-react-auth-action": "apply", key: "submit" }, busy ? "Sending…" : "Submit application"),
    h(ErrorMessage, { form: "apply", state, key: "error" }),
    h("button", {
      type: "button",
      className: "back-link",
      onClick: () => request("gvdg:member-apply-cancel"),
      key: "back",
    }, "Back to log in"),
  ]);
}

export function PinChangeForm({ active, state, onValuesChange }) {
  const newPin = state.values.newPin || "";
  const confirmPin = state.values.confirmPin || "";
  const newPinRef = React.useRef(null);

  React.useEffect(() => {
    if (active) newPinRef.current?.focus();
  }, [active]);

  return h("form", {
    className: "login-form",
    id: "pinChangeForm",
    autoComplete: "on",
    hidden: !active,
    onSubmit: (event) => {
      event.preventDefault();
      request("gvdg:member-pin-change-requested", { newPin, confirmPin });
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
      ref: newPinRef,
      value: newPin,
      onChange: (event) => onValuesChange("pin", { newPin: event.target.value }),
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
      value: confirmPin,
      onChange: (event) => onValuesChange("pin", { confirmPin: event.target.value }),
    })),
    h("button", { type: "submit", className: "login-btn", disabled: Boolean(state.busyAction), "data-react-auth-action": "pin", key: "save" }, state.busyAction === "pin" ? "Please wait…" : "Save PIN & Continue"),
    h(ErrorMessage, { form: "pin", state, key: "error" }),
  ]);
}

export function EmailForm({ active, state, onValuesChange }) {
  const values = state.values;
  const step = values.step === "code" ? "code" : "email";
  const busy = Boolean(state.busyAction);
  const set = (changes) => onValuesChange("email", changes);
  const copy = step === "code"
    ? `We sent a 6-digit code to ${values.sentTo || "your email"}. Enter it to confirm your email.`
    : values.required
      ? "Add your email so you can reset your PIN yourself if you ever forget it. It's never shown publicly."
      : "Your email is how you reset a forgotten PIN yourself. It's never shown publicly.";
  return h("form", {
    className: "login-form",
    id: "emailForm",
    autoComplete: "on",
    hidden: !active,
    "data-email-step": step,
    onSubmit: (event) => {
      event.preventDefault();
      if (step === "code") request("gvdg:member-email-verify-requested", { code: values.code || "" });
      else request("gvdg:member-email-start-requested", { email: values.email || "", pin: values.pin || "" });
    },
  }, [
    h("p", { className: "login-subtitle", key: "copy" }, copy),
    step === "email" ? h(FormGroup, { label: "Email", htmlFor: "memberEmailInput", key: "email" }, h("input", {
      type: "email",
      className: "form-input",
      id: "memberEmailInput",
      name: "email",
      autoComplete: "email",
      inputMode: "email",
      maxLength: 120,
      value: values.email || "",
      onChange: (event) => set({ email: event.target.value }),
    })) : null,
    step === "email" && values.pinNeeded ? h(FormGroup, { label: "Your PIN", htmlFor: "memberEmailPinInput", hint: "To confirm it's you.", key: "pin" }, h("input", {
      type: "password",
      className: "form-input",
      id: "memberEmailPinInput",
      name: "pin",
      inputMode: "numeric",
      autoComplete: "current-password",
      maxLength: 4,
      value: values.pin || "",
      onChange: (event) => set({ pin: event.target.value }),
    })) : null,
    step === "code" ? h(FormGroup, { label: "Code", htmlFor: "memberEmailCodeInput", key: "code" }, h("input", {
      type: "text",
      className: "form-input",
      id: "memberEmailCodeInput",
      name: "one-time-code",
      inputMode: "numeric",
      autoComplete: "one-time-code",
      maxLength: 6,
      placeholder: "6-digit code",
      value: values.code || "",
      onChange: (event) => set({ code: event.target.value }),
    })) : null,
    h("button", { type: "submit", className: "login-btn", disabled: busy, "data-react-auth-action": step === "code" ? "email-verify" : "email-start", key: "submit" },
      busy ? "Please wait…" : step === "code" ? "Confirm email" : "Send code"),
    h(ErrorMessage, { form: "email", state, key: "error" }),
    step === "code" ? h("button", {
      type: "button", className: "login-btn login-btn-secondary", disabled: busy, "data-react-auth-action": "email-resend", key: "resend",
      onClick: () => request("gvdg:member-email-start-requested", { email: values.sentTo || values.email || "", pin: values.pin || "" }),
    }, "Send a new code") : null,
    step === "code" ? h("button", {
      type: "button", className: "login-btn login-btn-secondary", disabled: busy, "data-react-auth-action": "email-different", key: "different",
      onClick: () => set({ step: "email", code: "" }),
    }, "Use a different email") : null,
    values.required
      ? h("button", { type: "button", className: "login-forgot", disabled: busy, "data-react-auth-action": "email-signout", key: "signout", onClick: () => request("gvdg:member-logout-requested") }, "Sign out")
      : h("button", { type: "button", className: "login-forgot", disabled: busy, "data-react-auth-action": "email-cancel", key: "cancel", onClick: () => request("gvdg:member-email-cancel") }, "Cancel"),
  ]);
}

export function ResetPinForm({ active, state, onValuesChange }) {
  const values = state.values;
  const step = values.step === "code" ? "code" : "start";
  const busy = Boolean(state.busyAction);
  const set = (changes) => onValuesChange("reset", changes);
  const pinInput = (id, name, field, label, placeholder) => h(FormGroup, { label, htmlFor: id, key: field }, h("input", {
    type: "password", className: "form-input", id, name, inputMode: "numeric", autoComplete: "new-password", maxLength: 4, placeholder,
    value: values[field] || "", onChange: (event) => set({ [field]: event.target.value }),
  }));
  return h("form", {
    className: "login-form",
    id: "resetPinForm",
    autoComplete: "on",
    hidden: !active,
    "data-reset-step": step,
    onSubmit: (event) => {
      event.preventDefault();
      if (step === "code") {
        request("gvdg:member-reset-verify-requested", {
          identifier: values.identifier || "", code: values.code || "", newPin: values.newPin || "", confirmPin: values.confirmPin || "",
        });
      } else request("gvdg:member-reset-start-requested", { identifier: values.identifier || "" });
    },
  }, [
    h("p", { className: "login-subtitle", key: "copy" }, step === "code"
      ? "If your account has an email, a 6-digit code is on its way to it. Enter it and choose a new PIN. No email on your account? A club admin can reset your PIN."
      : "Enter your PDGA #, UDisc username or email. We'll email a code to the address on your account."),
    step === "start" ? h(FormGroup, { label: "PDGA #, UDisc username or email", htmlFor: "resetIdentifierInput", key: "identifier" }, h("input", {
      type: "text",
      className: "form-input",
      id: "resetIdentifierInput",
      name: "identifier",
      autoComplete: "username",
      value: values.identifier || "",
      onChange: (event) => set({ identifier: event.target.value }),
    })) : null,
    step === "code" ? h(FormGroup, { label: "Code", htmlFor: "resetCodeInput", key: "code" }, h("input", {
      type: "text",
      className: "form-input",
      id: "resetCodeInput",
      name: "one-time-code",
      inputMode: "numeric",
      autoComplete: "one-time-code",
      maxLength: 6,
      placeholder: "6-digit code",
      value: values.code || "",
      onChange: (event) => set({ code: event.target.value }),
    })) : null,
    step === "code" ? pinInput("resetNewPinInput", "new-pin", "newPin", "New PIN", "Choose a 4-digit PIN") : null,
    step === "code" ? pinInput("resetConfirmPinInput", "confirm-pin", "confirmPin", "Confirm PIN", "Re-enter your PIN") : null,
    h("button", { type: "submit", className: "login-btn", disabled: busy, "data-react-auth-action": step === "code" ? "reset-verify" : "reset-start", key: "submit" },
      busy ? "Please wait…" : step === "code" ? "Set PIN & sign in" : "Email me a code"),
    h(ErrorMessage, { form: "reset", state, key: "error" }),
    step === "code" ? h("button", {
      type: "button", className: "login-btn login-btn-secondary", disabled: busy, "data-react-auth-action": "reset-resend", key: "resend",
      onClick: () => request("gvdg:member-reset-start-requested", { identifier: values.identifier || "" }),
    }, "Send a new code") : null,
    h("button", { type: "button", className: "login-forgot", disabled: busy, "data-react-auth-action": "reset-cancel", key: "cancel", onClick: () => request("gvdg:member-reset-cancel") }, "Back to sign in"),
  ]);
}

function ProfileEmailRow() {
  const { email } = useMemberContext();
  return h("div", { className: "form-group", "data-profile-email": email ? "set" : "missing" }, [
    h("span", { className: "form-label", key: "label" }, "Email"),
    h("p", { className: "profile-email-value", key: "value" }, email || "None yet. Add one so you can reset your PIN yourself."),
    h("button", {
      type: "button",
      className: "login-btn login-btn-secondary",
      "data-react-auth-action": "email-change",
      onClick: () => request("gvdg:member-email-change-requested"),
      key: "change",
    }, email ? "Change email" : "Add email"),
  ]);
}

export function ProfileForm({ active, state, onValuesChange }) {
  const [previewSrc, setPreviewSrc] = React.useState("");
  const pdga = state.values.pdga || "";
  const udisc = state.values.udisc || "";

  React.useEffect(() => {
    function update(event) {
      setPreviewSrc(typeof event.detail?.src === "string" ? event.detail.src : "");
    }

    window.addEventListener("gvdg:member-profile-preview", update);
    return () => window.removeEventListener("gvdg:member-profile-preview", update);
  }, []);

  return h("form", {
    className: "login-form",
    id: "profileForm",
    autoComplete: "on",
    hidden: !active,
    onSubmit: (event) => {
      event.preventDefault();
      request("gvdg:member-profile-save-requested", { pdga, udisc });
    },
  }, [
    h("p", { className: "login-subtitle", key: "copy" }, "Add your details so your ratings, stats and photo show up. All optional - you can do this later."),
    h(ProfileEmailRow, { key: "email" }),
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
        className: "member-file-input",
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
      value: pdga,
      onChange: (event) => onValuesChange("profile", { pdga: event.target.value }),
    })),
    h(FormGroup, { label: "UDisc username (optional)", htmlFor: "profileUdiscInput", key: "udisc" }, h("input", {
      type: "text",
      className: "form-input",
      id: "profileUdiscInput",
      placeholder: "your UDisc handle",
      value: udisc,
      onChange: (event) => onValuesChange("profile", { udisc: event.target.value }),
    })),
    h("button", { type: "submit", className: "login-btn", disabled: Boolean(state.busyAction), "data-react-auth-action": "profile-save", key: "save" }, state.busyAction === "save" ? "Please wait…" : "Save & Continue"),
    h("button", {
      type: "button",
      className: "login-btn login-btn-secondary",
      onClick: () => request("gvdg:member-profile-skip-requested"),
      key: "skip",
    }, "Skip for now"),
    h(ErrorMessage, { form: "profile", state, key: "error" }),
  ]);
}
