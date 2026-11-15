import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { destination, findTools, readAppRoute } from "../src/shared/app-navigation.js";
import { communityDate } from "../src/shared/community-labels.js";
import { sharedProfileHref } from "../src/members-app/community-panel.js";

test("community and discovery have stable routes alongside the existing directory", () => {
  assert.equal(destination("member", "community").group, "more");
  assert.equal(destination("member", "course-discovery").group, "play");
  assert.equal(readAppRoute("member", { hash: "#club" }).tab, "club");
  assert.equal(readAppRoute("member", { hash: "#course-discovery?course=31" }).courseId, "31");
  assert.equal(destination("admin", "review-queue").group, "more");
  assert.ok(findTools("step free", { role: "member" }).some((row) => row.key === "course-discovery"));
  assert.ok(findTools("course amenities").some((row) => row.key === "course-discovery"));
  assert.ok(findTools("moderate reviews", { role: "admin", isAdmin: true }).some((row) => row.key === "review-queue"));
  assert.deepEqual(findTools("moderate reviews", { role: "admin", isAdmin: false }), []);
  assert.match(readFileSync("admin.html", "utf8"), /id="adminCommunityReactApp"/);
});

test("shared profile URLs drop private context and use only the public key", () => {
  const key = "349ec82d-9f05-45dd-9e50-bc43d6976163";
  const url = new URL(sharedProfileHref(key, "https://gvdgclub.com/gvdg-members.html?token=private#practice?course=123"));
  assert.equal(url.pathname, "/gvdg-members.html");
  assert.equal(url.searchParams.get("profile"), key);
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.hash, "");
  assert.equal(communityDate("2026-11-14 23:49:10"), "2026-11-14");
  assert.equal(communityDate("unknown"), "");
});
