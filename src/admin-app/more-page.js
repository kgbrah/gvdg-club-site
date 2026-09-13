import React from "react";

const h = React.createElement;

const MORE_LINKS = [
  { tab: "courses", label: "Courses" },
  { tab: "layouts", label: "Layouts" },
  { tab: "tee-signs", label: "Tee signs" },
  { tab: "leagues-mgmt", label: "Leagues" },
  { tab: "fundraisers", label: "Fundraisers" },
  { tab: "meetings", label: "Meetings" },
  { tab: "members", label: "Members" },
  { tab: "data-archive", label: "Data archive" },
];

function requestTab(tab) {
  window.dispatchEvent(new CustomEvent("gvdg:admin-tab-request", { detail: { tab } }));
}

export function AdminMorePage() {
  return h("div", { "data-react-admin-more": "ready" }, [
    h("h2", { className: "admin-pane-heading", key: "title" }, "More"),
    h("p", { className: "dash-note", key: "note" }, "Courses, club ops, members, and archives."),
    h("div", { className: "admin-more-list", key: "list" }, MORE_LINKS.map((item) => h("button", {
      className: "admin-more-link",
      key: item.tab,
      onClick: () => requestTab(item.tab),
      type: "button",
    }, [item.label, h("span", { "aria-hidden": "true", key: "chev" }, "›")]))),
  ]);
}
