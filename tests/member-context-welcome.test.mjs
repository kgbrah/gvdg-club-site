import assert from "node:assert/strict";
import test from "node:test";

import { readMemberContext, setMemberContext } from "../src/members-app/member-context.js";

test("a routing event without `welcome` keeps a just-approved member's welcome flag", () => {
  setMemberContext({ sub: "m_new", name: "Nina Newbie", welcome: true });
  // gvdg:member-dashboard-ready carries route details only.
  assert.equal(readMemberContext({ tab: "overview", eventId: null }).welcome, true);
  assert.equal(readMemberContext().welcome, true);
});

test("an explicit welcome value still updates the flag", () => {
  setMemberContext({ sub: "m_new", welcome: true });
  assert.equal(readMemberContext({ sub: "m_new", welcome: false }).welcome, false);
  setMemberContext({ sub: "m_old", welcome: false });
  assert.equal(readMemberContext({ tab: "overview" }).welcome, false);
});
