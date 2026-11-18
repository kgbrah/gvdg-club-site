import React from "react";
import { Camera, ChevronRight, CircleHelp, ClipboardList, Disc3, ExternalLink, FlaskConical, Globe, HandHeart, KeyRound, Mail, MessageSquare, Palette,
  ShieldCheck, Smartphone, Tag, Trophy, UserRound, Users, Wallet } from "lucide-react";

import { ToolFinder } from "../shared/tool-finder.js";
import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";
import { inAppHost, installCoachCopy, installCoachMode, isStandaloneDisplay } from "../shared/install-coach.js";
import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { WalletPanel } from "./activity-panels.js";
import { TOKEN_KEY, storageGet } from "./api.js";
import { selectDashboardTab, requestLogout } from "./dashboard-shell.js";
export { MoreLink } from "./more-link.js";
import { useMemberContext } from "./member-context.js";
import { membershipAccountLine } from "../shared/membership-status.js";
import { DiscColorPicker } from "./disc-color-picker.js";
import { DashboardThemeBuilder } from "./dashboard-theme.js";
import { MemberPhoneActivityPanel } from "./phone-activity-panel.js";
import { MemberNotificationsPanel } from "./notifications-panel.js";
import { fieldTestUsed } from "../shared/field-test-gate.js";
import { FieldTestSwitch, useFieldTestMode } from "../shared/field-test-ui.js";
import { KarmaChip } from "../shared/karma.js";

const h = React.createElement;
const PASSKEY_STATE_EVENT = "gvdg:member-passkey-state";

function MemberLinkRow({ title, detail, icon: Icon, tab, href, onClick, ...attributes }) {
  const Arrow = href ? ExternalLink : ChevronRight;
  const descriptionId = React.useId();
  return h(href ? "a" : "button", {
    ...attributes, className: "member-link-row", "aria-label": title, "aria-describedby": detail ? descriptionId : undefined,
    ...(href ? { href } : { type: "button", onClick: onClick || (() => selectDashboardTab(tab)) }),
  }, [
    h(Icon, { className: "member-link-icon", size: 19, "aria-hidden": true, key: "icon" }),
    h("span", { className: "member-link-copy", key: "copy" }, [
      h("strong", { key: "title" }, title),
      detail ? h("small", { id: descriptionId, key: "detail" }, detail) : null,
    ]),
    h(Arrow, { className: "member-link-arrow", size: 17, "aria-hidden": true, key: "arrow" }),
  ]);
}

function MemberLinkSection({ title, children, ...attributes }) {
  return h("section", { ...attributes, className: "member-link-section", "aria-label": title },
    h("h2", null, title), h("div", { className: "member-link-list" }, children));
}

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

  return h("div", { "data-react-account-tools": "ready", "aria-label": "Account tools" }, [
    h("div", { className: "member-link-list", key: "actions" }, [
      h(MemberLinkRow, { title: "Edit profile", icon: UserRound, id: "editProfileBtn", key: "profile",
        onClick: () => request("gvdg:member-edit-profile-requested") }),
      supportsPasskeys ? h(MemberLinkRow, {
        title: passkeyState.busy ? "Adding passkey…" : "Add a passkey", icon: KeyRound, key: "passkey",
        "data-react-passkey-action": "add", disabled: passkeyState.busy,
        onClick: () => request("gvdg:member-add-passkey-requested"),
      }) : null,
    ]),
    h("span", { className: "passkey-status", "data-react-passkey-status": passkeyState.message ? "message" : "empty",
      role: "status", "aria-live": "polite", key: "status" }, passkeyState.message),
  ]);
}

export function MemberMorePage() {
  const { isAdmin } = useMemberContext();
  return h("div", { className: "react-more-page member-subpage", "data-react-more-page": "ready" }, [
    h(ToolFinder, { key: "finder", isAdmin, onNavigate: selectDashboardTab }),
    h("div", { className: "member-subgrid", key: "groups" }, [
      h(MemberLinkSection, { title: "Members and club activity", key: "people" }, [
        h(MemberLinkRow, { tab: "club", title: "Club directory", detail: "Members, course conditions and minutes", icon: Users, key: "club" }),
        h(MemberLinkRow, { tab: "community", title: "Community", detail: "Your profile and friends", icon: UserRound, key: "community" }),
        h(MemberLinkRow, { tab: "messages", title: "Messages", detail: "Direct messages and club updates", icon: Mail, key: "messages" }),
        h(MemberLinkRow, { tab: "board", title: "Message board", icon: MessageSquare, key: "board" }),
      ]),
      h(MemberLinkSection, { title: "On the course", key: "play" }, [
        h(MemberLinkRow, { tab: "tags", title: "Bag tags", detail: "Reserve a tag or manage challenges", icon: Tag, key: "tags" }),
        h(MemberLinkRow, { tab: "standings", title: "Club standings", icon: Trophy, key: "standings" }),
        h(MemberLinkRow, { tab: "tee", title: "Tee signs", detail: "Contribute a tee sign photo", icon: Camera, key: "tee" }),
        h(MemberLinkRow, { tab: "lost-found", title: "Lost & Found", detail: "Found a disc? Lost one? Help it get home", icon: HandHeart, key: "lost-found" }),
      ]),
      h(MemberLinkSection, { title: "Club sites", key: "sites" }, [
        h(MemberLinkRow, { title: "Pro shop", icon: Tag, href: "pro-shop.html", key: "shop" }),
        h(MemberLinkRow, { tab: "marketplace", title: "Marketplace", detail: "Buy, sell and trade used discs", icon: Disc3, key: "marketplace" }),
        h(MemberLinkRow, { title: "Club website", icon: Globe, href: "index.html", key: "home" }),
      ]),
    ]),
  ]);
}

// Account > Devices: the opt-in switch, plus the log once this phone has used field test mode.
function FieldTestRows() {
  const on = useFieldTestMode();
  return h(React.Fragment, null, [
    h(FieldTestSwitch, {
      app: "members", key: "switch", rowClass: "member-link-row member-switch-row", copyClass: "member-link-copy",
      trackClass: "member-switch", knobClass: "member-switch-knob",
      icon: h(FlaskConical, { className: "member-link-icon", size: 19, "aria-hidden": true, key: "icon" }),
    }),
    on || fieldTestUsed() ? h(MemberLinkRow, {
      tab: "field-test", title: "Field log", detail: "Summary, notes and export", icon: ClipboardList, key: "log",
      "data-member-field-log-link": "ready",
    }) : null,
  ]);
}

function AdminPortalBanner() {
  const description = React.useId();
  return h("a", {
    "aria-label": "Admin portal", "aria-describedby": description, className: "member-admin-banner",
    "data-react-admin-portal": "ready", href: "admin.html", id: "adminPortalLink",
  }, [
    h(ShieldCheck, { "aria-hidden": true, size: 21, key: "icon" }),
    h("span", { className: "member-admin-copy", key: "copy" }, [
      h("strong", { key: "title" }, "Admin portal"),
      h("small", { id: description, key: "detail" }, "Manage club events and members"),
    ]),
    h(ChevronRight, { "aria-hidden": true, size: 18, key: "arrow" }),
  ]);
}

export function MemberAccountPage() {
  const context = useMemberContext();
  return h("div", { className: "react-more-page member-subpage member-account-page", "data-react-member-account": "ready" }, [
    context.isAdmin ? h(AdminPortalBanner, { key: "admin" }) : null,
    h("section", { className: "member-link-section", "aria-label": "Membership", key: "membership" }, [
      h("div", { className: "member-settings-profile", key: "profile" }, [
        context.photo ? h("img", { src: context.photo, alt: "", key: "photo" }) : h(UserRound, { size: 25, "aria-hidden": true, key: "icon" }),
        h("div", { key: "body" }, [
          h("h2", { key: "name" }, h("span", { className: "karma-line" }, [
            h("span", { key: "n" }, context.name || "Club membership"),
            h(KarmaChip, { key: "karma", memberId: context.sub || "" }),
          ])),
          h("p", { className: "player-card-meta", key: "meta" }, context.pdgaNo ? "PDGA #" + context.pdgaNo : "Greenville DGC member"),
          membershipAccountLine(context.membership)
            ? h("p", { className: "player-card-meta", key: "dues" }, membershipAccountLine(context.membership))
            : null,
        ]),
      ]),
      h(AccountTools, { key: "account-tools" }),
    ]),
    h("div", { className: "member-subgrid", key: "settings" }, [
      h(MemberLinkSection, { title: "Preferences", key: "prefs" }, [
        h(MemberLinkRow, { tab: "wallet", title: "Wallet", detail: "Balance and store credit activity", icon: Wallet, key: "wallet" }),
        h(MemberLinkRow, { tab: "appearance", title: "Appearance", detail: "Theme, wallpaper and disc colors", icon: Palette, key: "appearance" }),
      ]),
      h(MemberLinkSection, { title: "Devices", "data-member-account-devices": "ready", key: "devices" }, [
        h(MemberLinkRow, { tab: "install", title: "Install app", detail: "Add GVDG to your home screen", icon: Smartphone, key: "install" }),
        h(MemberNotificationsPanel, { key: "notifications" }),
        h(MemberPhoneActivityPanel, { key: "phone-activity" }),
        h(FieldTestRows, { key: "field-test" }),
      ]),
      h(MemberLinkSection, { title: "Support", key: "support" }, [
        h(MemberLinkRow, { title: "Club website", icon: Globe, href: "index.html", key: "site" }),
        h(CrottsHelpLink, { className: "member-link-row", key: "help" }, [
          h(CircleHelp, { className: "member-link-icon", size: 19, "aria-hidden": true, key: "icon" }),
          h("span", { className: "member-link-copy", key: "copy" }, h("strong", null, "Help")),
          h(ChevronRight, { className: "member-link-arrow", size: 17, "aria-hidden": true, key: "arrow" }),
        ]),
      ]),
    ]),
    h("button", {
      className: "player-logout-btn", id: "logoutBtn", key: "logout", onClick: requestLogout, type: "button",
    }, "Log out"),
  ]);
}

export function MemberAppearancePage() {
  return h("div", { className: "react-more-page member-subpage member-appearance" }, [
    h("section", { className: "player-card member-appearance-toggle", "aria-label": "Light or dark mode", key: "mode" }, [
      h("div", { key: "copy" }, h("h2", null, "Display mode"), h("p", { className: "player-card-meta" }, "Light or dark mode")),
      h(PlayerThemeToggle, { key: "toggle" }),
    ]),
    h(DiscColorPicker, { key: "disc-color" }),
    h(DashboardThemeBuilder, { key: "theme" }),
  ]);
}

export function MemberWalletPage() {
  const token = storageGet(TOKEN_KEY);
  return h("div", { className: "react-more-page member-subpage member-wallet-page" }, [
    h(WalletPanel, { token, key: "wallet" }),
  ]);
}

export function MemberInstallPage() {
  const standalone = isStandaloneDisplay((query) => window.matchMedia(query).matches, navigator.standalone);
  const mode = installCoachMode(undefined, standalone);
  const [manual, setManual] = React.useState(false);
  const copy = installCoachCopy(mode, location.href, inAppHost());
  return h("section", { className: "player-card member-install", "aria-label": "Install GVDG app" }, [
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
