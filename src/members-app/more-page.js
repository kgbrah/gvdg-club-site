import React from "react";

import { destination } from "../shared/app-navigation.js";
import { ToolFinder } from "../shared/tool-finder.js";
import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";
import { inAppHost, installCoachCopy, installCoachMode, isStandaloneDisplay } from "../shared/install-coach.js";
import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { WalletPanel } from "./activity-panels.js";
import { TOKEN_KEY, storageGet } from "./api.js";
import { selectDashboardTab, requestLogout } from "./dashboard-shell.js";
import { useMemberContext } from "./member-context.js";
import { DiscColorPicker } from "./disc-color-picker.js";
import { DashboardThemeBuilder } from "./dashboard-theme.js";

const h = React.createElement;
const PASSKEY_STATE_EVENT = "gvdg:member-passkey-state";

function AccountTools() {
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [passkeyState, setPasskeyState] = React.useState({ busy: false, message: "" });

  React.useEffect(() => {
    setSupportsPasskeys(typeof window.PublicKeyCredential !== "undefined");
  }, []);

  React.useEffect(() => {
    function update(event) {
      setPasskeyState((previous) => ({
        busy: typeof event.detail?.busy === "boolean" ? event.detail.busy : previous.busy,
        message: typeof event.detail?.message === "string" ? event.detail.message : previous.message,
      }));
    }

    window.addEventListener(PASSKEY_STATE_EVENT, update);
    return () => window.removeEventListener(PASSKEY_STATE_EVENT, update);
  }, []);

  function request(eventName) {
    window.dispatchEvent(new CustomEvent(eventName));
  }

  return h("div", { className: "dashboard-utility-panel account-dashboard-utility react-account-tools", "data-react-account-tools": "ready", "aria-label": "Account tools" }, [
    h("div", { className: "player-more-grid", key: "actions" }, [
      supportsPasskeys
        ? h("button", {
          type: "button",
          className: "player-more-item",
          "data-react-passkey-action": "add",
          disabled: passkeyState.busy,
          onClick: () => request("gvdg:member-add-passkey-requested"),
          key: "passkey",
        }, passkeyState.busy ? "Adding passkey..." : "Add a passkey")
        : null,
      h("button", {
        type: "button",
        className: "player-more-item",
        id: "editProfileBtn",
        onClick: () => request("gvdg:member-edit-profile-requested"),
        key: "profile",
      }, "Edit profile"),
    ].filter(Boolean)),
    h("span", { className: "passkey-status", "data-react-passkey-status": passkeyState.message ? "message" : "empty", role: "status", "aria-live": "polite", key: "status" }, passkeyState.message),
  ]);
}

export function MoreLink({ tab, label }) {
  return h("button", {
    type: "button",
    className: "player-more-item",
    onClick: () => selectDashboardTab(tab),
  }, label || destination("member", tab).label);
}

export function MemberMorePage() {
  const { isAdmin } = useMemberContext();
  return h("div", { className: "react-more-page", "data-react-more-page": "ready" }, [
    h(ToolFinder, { key: "finder", isAdmin, onNavigate: selectDashboardTab }),
    h("div", { className: "player-more-grid", key: "links" }, [
      ...["club", "board", "tags", "standings", "tee"].map((tab) => h(MoreLink, { tab, key: tab })),
      h("a", { className: "player-more-item", href: "pro-shop.html", key: "shop" }, "Pro shop"),
      h("a", { className: "player-more-item", href: "index.html", key: "home" }, "Club website"),
    ]),
  ]);
}

export function MemberAccountPage() {
  const context = useMemberContext();
  return h("div", { className: "react-more-page", "data-react-member-account": "ready" }, [
    h("section", { className: "player-card", "aria-label": "Membership", key: "membership" }, [
      h("h2", { key: "heading" }, context.name || "Club membership"),
      h("p", { className: "player-card-meta", key: "profile" }, context.pdgaNo ? "PDGA #" + context.pdgaNo : "Greenville DGC member"),
      h(AccountTools, { key: "account-tools" }),
    ]),
    h("div", { className: "player-more-grid", key: "links" }, [
      ...["wallet", "appearance", "install"].map((tab) => h(MoreLink, { tab, key: tab })),
      h("a", { className: "player-more-item", href: "index.html", key: "website" }, "Club website"),
      h(CrottsHelpLink, { className: "player-more-item", key: "help" }),
      context.isAdmin ? h("a", { className: "player-more-item", href: "admin.html", key: "admin" }, "Admin portal") : null,
    ]),
    h("button", {
      className: "player-logout-btn", id: "logoutBtn", key: "logout", onClick: requestLogout, type: "button",
    }, "Log out"),
  ]);
}

export function MemberAppearancePage() {
  return h("div", { className: "react-more-page" }, [
    h("div", { className: "member-appearance-toggle", key: "mode" }, [
      h("span", { key: "label" }, "Light or dark mode"), h(PlayerThemeToggle, { key: "toggle" }),
    ]),
    h(DiscColorPicker, { key: "disc-color" }),
    h(DashboardThemeBuilder, { key: "theme" }),
  ]);
}

export function MemberWalletPage() {
  const token = storageGet(TOKEN_KEY);
  return h("div", { className: "react-more-page" }, [
    h(WalletPanel, { token, key: "wallet" }),
  ]);
}

export function MemberInstallPage() {
  const standalone = isStandaloneDisplay((query) => window.matchMedia(query).matches, navigator.standalone);
  const mode = installCoachMode(undefined, standalone);
  const [manual, setManual] = React.useState(false);
  const copy = installCoachCopy(mode, location.href, inAppHost());
  return h("section", { className: "player-card", "aria-label": "Install GVDG app" }, [
    h("p", { className: "player-card-meta", key: "copy" }, standalone ? "This app is already installed." : copy.body),
    !standalone && copy.href ? h("a", { className: "dashboard-action", href: copy.href, key: "browser" }, copy.action) : null,
    mode === "prompt" ? h("button", {
      className: "dashboard-action primary", key: "prompt", type: "button",
      onClick: () => {
        window.dispatchEvent(new CustomEvent("gvdg:pwa-install-prompt"));
        setManual(true);
      },
    }, "Install app") : null,
    manual ? h("p", { className: "player-card-meta", role: "status", key: "fallback" }, "If no install window opens, look for Install app in your browser menu.") : null,
  ]);
}
