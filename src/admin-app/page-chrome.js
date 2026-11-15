import React from "react";
import { ClubLogo } from "../shared/club-logo.js";
import { CrottsHelpLink } from "../shared/crotts-widget.js";

const h = React.createElement;

export function AdminPageChrome() {
  return h("header", { className: "admin-app-header", "data-react-admin-chrome": "true" }, h("nav", { "aria-label": "Admin header" }, [
    h("div", { className: "admin-header-brand", key: "brand" }, [
      h(ClubLogo, { href: "admin.html", key: "logo" }),
      h("strong", { key: "admin" }, "Admin"),
    ]),
    h("div", { className: "admin-header-actions", key: "actions" }, [
      h("a", { className: "admin-header-link admin-header-members", href: "gvdg-members.html", key: "members", "aria-label": "Member app" },
        h("span", { className: "admin-header-full" }, "Member app"),
        h("span", { className: "admin-header-short" }, "Members")),
      h(CrottsHelpLink, { className: "admin-header-link", key: "help" }, "Help"),
    ]),
  ]));
}
