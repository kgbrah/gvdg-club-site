import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_DESTINATIONS, ADMIN_PRIMARY, MEMBER_DESTINATIONS, MEMBER_PRIMARY,
  appHref, destination, findTools, navigationHref, readAppRoute,
} from "../src/shared/app-navigation.js";

const read = (name) => readFileSync(name, "utf8");
const hash = (role, fragment) => readAppRoute(role, { hash: fragment, search: "" });

test("every legacy pane has an exact URL, registered destination, group, and rendered mount", () => {
  const legacyMember = {
    overview: "myDashboard", play: "playerPlay", events: "clubRegister", season: "mySeason",
    more: "playerMore", board: "clubBoard", tee: "teeCapture", club: "membersReactClubPanel",
  };
  const memberContent = read("src/members-app/dashboard-app.js");
  for (const [key, id] of Object.entries(legacyMember)) {
    assert.equal(hash("member", "#" + key).tab, key);
    assert.ok(MEMBER_PRIMARY.includes(destination("member", key).group));
    assert.ok(memberContent.includes(`id: "${id}"`));
  }

  const legacyAdmin = [
    "today", "events", "create", "import", "registration", "scoring", "shop", "orders", "wallets",
    "members", "courses", "layouts", "tee-signs", "leagues-mgmt", "bag-tags", "fundraisers",
    "meetings", "data-archive", "more",
  ];
  const adminHtml = read("admin.html");
  for (const key of legacyAdmin) {
    assert.equal(hash("admin", "#" + key).tab, key);
    assert.ok(adminHtml.includes(`id="apane-${key}"`));
  }
  for (const row of ADMIN_DESTINATIONS) assert.ok(adminHtml.includes(`id="apane-${row.pane || row.key}"`));
  assert.deepEqual(MEMBER_PRIMARY.map((key) => destination("member", key).label), ["Home", "Play", "Events", "Stats", "Club"]);
  assert.deepEqual(ADMIN_PRIMARY.map(({ label }) => label), ["Today", "Events", "Members", "Money", "Tools"]);
});

test("canonical routes round trip selected context and accept old query-based notifications", () => {
  for (const [role, registry] of [["member", MEMBER_DESTINATIONS], ["admin", ADMIN_DESTINATIONS]]) {
    for (const route of registry) assert.equal(hash(role, appHref(role, route.key)).tab, route.key);
  }
  assert.deepEqual(hash("admin", "#registration/42"), { tab: "registration", eventId: "42", courseId: null, filter: null });
  assert.deepEqual(hash("admin", "#tee-signs?course=17&filter=candidate"), { tab: "tee-signs", eventId: null, courseId: "17", filter: "candidate" });
  assert.equal(readAppRoute("admin", { search: "?tab=orders" }).tab, "orders");
  assert.equal(readAppRoute("admin", { search: "?tab=members" }).tab, "members");
  assert.equal(readAppRoute("admin", { search: "?tab=bag-tags" }).tab, "bag-tags");
  assert.equal(readAppRoute("admin", { search: "?tab=tee-signs" }).tab, "tee-signs");
  assert.equal(readAppRoute("member", { hash: "#tee", search: "?course=7" }).courseId, "7");
  assert.equal(readAppRoute("admin", { hash: "#scoring?event=unsafe", search: "?tab=money&event=2" }).eventId, null);
  const href = navigationHref("admin", { pathname: "/admin.html", search: "?tab=orders&test=1" }, "check-in", { eventId: "42" });
  assert.equal(href, "/admin.html?test=1#check-in?event=42");
});

test("search covers common tasks while showing only authorized tool names", () => {
  const tasks = {
    "import event": "import",
    "google sheets": "sheets",
    "store credit balances": "sheets",
    "new tournament": "create",
    "approve an application": "applications",
    "check attendance": "check-in",
    "start live scoring": "scoring",
    "fulfill order": "orders",
    "edit pars": "layouts",
    "review course photo": "tee-signs",
  };
  for (const [query, target] of Object.entries(tasks)) {
    assert.ok(findTools(query, { role: "admin", isAdmin: true }).some((item) => item.key === target), query);
  }
  assert.deepEqual(findTools("wallet", { role: "admin", isAdmin: false }), []);
  assert.deepEqual(findTools("admin"), []);
  assert.ok(findTools("admin", { role: "member", isAdmin: true }).some((item) => item.href === "admin.html"));
  assert.ok(findTools("look up UDisc CSV").length === 0);
  assert.ok(findTools("UDisc CSV").some((item) => item.key === "imports"));
  assert.ok(findTools("round replay").some((item) => item.key === "play"));
});

test("member router translates legacy events into history and restores the selected destination on Back", async () => {
  const previous = globalThis.window;
  const window = new EventTarget();
  let url = new URL("https://club.invalid/gvdg-members.html?course=12#tee");
  const entries = [];
  window.location = url;
  window.history = { pushState(_state, _label, path) { entries.push(path); url = new URL(path, url); window.location = url; } };
  globalThis.window = window;
  try {
    const { currentDashboardTab, installDashboardRouter, currentDashboardRoute } = await import("../src/members-app/dashboard-router.js");
    const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
    installDashboardRouter();
    emit("gvdg:member-dashboard-opened", {});
    assert.equal(currentDashboardTab(), "tee");
    assert.equal(currentDashboardRoute().courseId, "12");
    emit("gvdg:select-dashboard-tab", { tab: "events", eventId: "42" });
    assert.deepEqual(entries, ["/gvdg-members.html#events?event=42"]);
    assert.equal(currentDashboardRoute().eventId, "42");
    window.location = new URL("https://club.invalid/gvdg-members.html?course=12#tee");
    emit("popstate");
    assert.equal(currentDashboardRoute().courseId, "12");
    assert.equal(entries.length, 1);
    emit("gvdg:member-shell-view", { view: "auth" });
    emit("gvdg:select-dashboard-tab", { tab: "account" });
    assert.equal(currentDashboardTab(), "tee");
  } finally {
    globalThis.window = previous;
  }
});
