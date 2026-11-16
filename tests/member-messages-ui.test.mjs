import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { findTools, readAppRoute } from "../src/shared/app-navigation.js";

const read = (name) => readFileSync(name, "utf8");

test("messages is a club destination with an inbox, a home alert, and a nav badge", () => {
  const panel = read("src/members-app/messages-panel.js");
  const app = read("src/members-app/dashboard-app.js");
  const shell = read("src/members-app/dashboard-shell.js");
  const more = read("src/members-app/more-page.js");
  const home = read("src/members-app/overview-dashboard.js");
  const css = read("member-surfaces.css");
  assert.equal(readAppRoute("member", { hash: "#messages?thread=12", search: "" }).tab, "messages");
  assert.ok(findTools("direct message").some((item) => item.key === "messages"));
  assert.match(app, /tab === "messages" && token \? h\(MemberMessagesPanel/);
  assert.match(panel, /\/me\/messages/);
  assert.match(panel, /\/me\/notices/);
  assert.match(home, /InboxHomeAlert/);
  assert.match(more, /tab: "messages"/);
  assert.match(shell, /member-nav-badge/);
  assert.match(css, /\.member-bubble/);
  assert.match(css, /overflow-wrap: normal/);
});
