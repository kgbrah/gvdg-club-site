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
      h("a", { className: "admin-header-link", href: "gvdg-members.html", key: "members" }, "Member app"),
      h(CrottsHelpLink, { className: "admin-header-link", key: "help" }, "Help"),
    ]),
  ]));
}
