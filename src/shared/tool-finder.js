import React from "react";
import { Search } from "lucide-react";
import { requestCrottsHelp } from "./crotts-widget.js";
import { findTools } from "./app-navigation.js";

const h = React.createElement;

export function ToolFinder({ role = "member", isAdmin, onNavigate }) {
  const id = React.useId();
  const input = React.useRef(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const results = open ? findTools(query, { role, isAdmin }) : [];
  const showing = open && Boolean(query.trim());
  function choose(item) {
    if (!item) return;
    setOpen(false);
    setQuery("");
    if (item.action === "help") requestCrottsHelp(() => input.current);
    else if (item.key) onNavigate(item.key);
    else if (item.href) location.assign(item.href);
  }
  return h("div", {
    className: "app-tool-finder",
    onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); },
    onKeyDown: (event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); input.current?.focus(); } },
  }, [
    h("form", {
      role: "search", "aria-label": role === "admin" ? "Admin tools" : "Member tools", key: "form",
      onSubmit: (event) => { event.preventDefault(); choose(results[0]); },
    }, [
      h("label", { htmlFor: id, key: "label", className: "app-tool-label" }, "Find a tool"),
      h("div", { className: "app-tool-field", key: "field" }, [
        h(Search, { "aria-hidden": true, size: 18, className: "app-tool-icon", key: "icon" }),
        h("input", {
          ref: input, id, value: query, type: "search", autoComplete: "off", placeholder: "Find a tool", key: "input",
          onChange: (event) => { setQuery(event.target.value); setOpen(true); },
          onFocus: () => setOpen(true),
        }),
      ]),
    ]),
    showing ? h("div", { className: "app-tool-results", key: "results" }, results.length
      ? h("ul", { "aria-label": "Matching tools" }, results.map((item) => h("li", { key: item.key || item.label },
        item.href
          ? h("a", { href: item.href, onClick: () => { setOpen(false); setQuery(""); } }, item.label)
          : h("button", { type: "button", onClick: () => choose(item) }, item.label))))
      : h("p", { role: "status" }, "No matching tools.")) : null,
  ]);
}
