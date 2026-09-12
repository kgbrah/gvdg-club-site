import React from "react";

import { WalletPanel } from "./activity-panels.js";
import { TOKEN_KEY, storageGet } from "./api.js";
import { selectDashboardTab, requestLogout } from "./dashboard-shell.js";

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

function MoreLink({ tab, label }) {
  return h("button", {
    type: "button",
    className: "player-more-item",
    onClick: () => selectDashboardTab(tab),
  }, label);
}

export function MemberMorePage() {
  const token = storageGet(TOKEN_KEY);
  return h("div", { className: "react-more-page", "data-react-more-page": "ready" }, [
    h("div", { className: "player-more-grid", key: "links" }, [
      h(MoreLink, { tab: "club", label: "Club directory", key: "club" }),
      h(MoreLink, { tab: "board", label: "Message board", key: "board" }),
      h(MoreLink, { tab: "tee", label: "Tee signs", key: "tee" }),
      h("a", { className: "player-more-item", href: "pro-shop.html", key: "shop" }, "Pro shop"),
      h("a", { className: "player-more-item", href: "score.html", key: "score" }, "Live scoring"),
    ]),
    h(WalletPanel, { token, key: "wallet" }),
    h(AccountTools, { key: "account-tools" }),
    h("section", { className: "player-card", key: "theme" }, [
      h("h3", { key: "title" }, "Theme tokens"),
      h("p", { className: "player-card-meta", key: "copy" }, "Wired to tokens.css. The in-flight theme builder can restyle this app without a layout rewrite. Use the header toggle for light / dark."),
      h("div", { className: "player-theme-grid", key: "swatches" }, [
        h("div", { className: "player-swatch", key: "primary" }, [h("i", { className: "player-swatch-primary", key: "i" }), h("label", { key: "l" }, "Primary")]),
        h("div", { className: "player-swatch", key: "navy" }, [h("i", { className: "player-swatch-secondary", key: "i" }), h("label", { key: "l" }, "Navy")]),
        h("div", { className: "player-swatch", key: "green" }, [h("i", { className: "player-swatch-green", key: "i" }), h("label", { key: "l" }, "Green")]),
        h("div", { className: "player-swatch", key: "gold" }, [h("i", { className: "player-swatch-accent", key: "i" }), h("label", { key: "l" }, "Gold")]),
      ]),
    ]),
    h("button", {
      className: "player-logout-btn",
      id: "logoutBtn",
      key: "logout",
      onClick: requestLogout,
      type: "button",
    }, "Log Out"),
  ]);
}
