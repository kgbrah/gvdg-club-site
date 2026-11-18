import assert from "node:assert/strict";
import test from "node:test";

import {
  aiFieldsNote, composeArea, discTitle, holdingText, karmaLabel, lfErrorMessage, parseLfRoute, personHref, postMeta, postPayload, safeRoundReturn,
  validatePost,
} from "../src/shared/lost-found-model.js";

test("lost & found routes", () => {
  const pick = (hash) => {
    const { tab, view, id, key, kind } = parseLfRoute(hash);
    return { tab, view, id, key, kind };
  };
  assert.deepEqual(pick(""), { tab: "found", view: "list", id: null, key: null, kind: null });
  assert.deepEqual(pick("#lost"), { tab: "lost", view: "list", id: null, key: null, kind: null });
  assert.deepEqual(pick("#returned"), { tab: "returned", view: "wall", id: null, key: null, kind: null });
  assert.deepEqual(pick("#mine"), { tab: "mine", view: "mine", id: null, key: null, kind: null });
  assert.deepEqual(pick("#new/lost"), { tab: "lost", view: "new", id: null, key: null, kind: "lost" });
  assert.deepEqual(pick("#post/12"), { tab: "found", view: "post", id: 12, key: null, kind: null });
  assert.deepEqual(pick("#match/3"), { tab: "mine", view: "match", id: 3, key: null, kind: null });
  assert.deepEqual(pick("#claim/4"), { tab: "mine", view: "claim", id: 4, key: null, kind: null });
  assert.deepEqual(pick("#celebrate/5"), { tab: "mine", view: "celebrate", id: 5, key: null, kind: null });
  assert.deepEqual(pick("#person/0123456789abcdef01"), { tab: "returned", view: "person", id: null, key: "0123456789abcdef01", kind: null });
  assert.equal(pick("#person/<script>").view, "list");
  assert.equal(pick("#post/0").view, "list");
  assert.equal(pick("#post/-1").view, "list");
  assert.equal(parseLfRoute("#found?course=4&q=star").query.get("course"), "4");
  assert.equal(personHref("nope"), "#returned");
});

test("karma badge and disc labels", () => {
  assert.equal(karmaLabel({ karma: 30, returned: 3 }), "Karma 30 · 3 discs returned");
  assert.equal(karmaLabel({ karma: 10, returned: 1 }), "Karma 10 · 1 disc returned");
  assert.equal(karmaLabel({ karma: 0, returned: 0 }), "");
  assert.equal(karmaLabel({ karma: 4, returned: 0 }), "Karma 4");
  assert.equal(karmaLabel({ karma: -12, returned: 0 }), "Karma \u221212");
  assert.equal(karmaLabel(null), "");
  assert.equal(discTitle({ brand: "Innova", plastic: "Star", mold: "Destroyer" }), "Innova Star Destroyer");
  assert.equal(discTitle({ color: "Orange" }), "Orange disc");
  assert.equal(discTitle({}), "Disc");
  assert.equal(aiFieldsNote(["brand", "mold"]), "Brand and mold read from the photo");
  assert.equal(aiFieldsNote(["brand", "mold", "color"]), "Brand, mold and colour read from the photo");
  assert.equal(aiFieldsNote([]), "");
  assert.equal(postMeta({ kind: "found", course: { name: "Elm Street Park" }, area: "Hole 7", date: "2026-11-12" }), "Elm Street Park · Hole 7 · Found Nov 12");
  assert.equal(holdingText({ kind: "found", holding: "club_bin", binNote: "Elm Street shed" }), "Turned in to the club bin at Elm Street shed");
  assert.equal(holdingText({ kind: "found", holding: "finder" }), "The finder has it");
  assert.equal(holdingText({ kind: "lost" }), "");
});

test("post payload and validation mirror the Worker", () => {
  const found = postPayload("found", { brand: " Innova ", courseId: "3", holding: "club_bin", binNote: "Shed", privateInk: "secret" }, ["a", "b", "c", "d"]);
  assert.deepEqual(found, { kind: "found", brand: "Innova", mold: "", plastic: "", color: "", area: "", courseId: 3, holding: "club_bin", binNote: "Shed", photos: ["a", "b", "c"] });
  assert.equal("privateInk" in found, false, "a found post never sends private ink");
  const lost = postPayload("lost", { mold: "Buzzz", privateInk: " Ada 252-555-0134 ", rewardNote: "$10" }, []);
  assert.equal(lost.privateInk, "Ada 252-555-0134");
  assert.equal(lost.rewardNote, "$10");
  assert.equal(lost.courseId, undefined);
  assert.deepEqual(validatePost("found", {}, 0), { field: "photos", text: "Add at least one photo of the disc." });
  assert.equal(validatePost("found", {}, 1), null);
  assert.equal(validatePost("found", { holding: "club_bin" }, 1).field, "binNote");
  assert.equal(validatePost("lost", {}, 0).field, "mold");
  assert.equal(validatePost("lost", { privateInk: "AL" }, 0), null);
  // Weight and hole come from pick-lists; the hole leads the area text.
  const picked = postPayload("found", { weightG: "175", hole: "7", area: " by the pond " }, []);
  assert.deepEqual([picked.weightG, picked.hole, picked.area], [175, 7, "Hole 7 · by the pond"]);
  const off = postPayload("found", { weightG: "", hole: "off", area: "Parking lot" }, []);
  assert.deepEqual([off.weightG, off.hole, off.area], [undefined, undefined, "Parking lot"]);
  assert.equal(composeArea("12", ""), "Hole 12");
  assert.equal(validatePost("found", { area: "x".repeat(49) }, 1).field, "area");
  assert.equal(safeRoundReturn("score.html?round=AB12#hole/3"), "score.html?round=AB12#hole/3");
  assert.equal(safeRoundReturn("https://evil.example/score.html"), "");
  assert.equal(safeRoundReturn("javascript:alert(1)"), "");
  assert.equal(safeRoundReturn("//evil.example"), "");
  assert.equal(lfErrorMessage({ error: "own_post" }), "That's your own post.");
  assert.equal(lfErrorMessage({ error: "???" }, "fallback"), "fallback");
});

test("Lost & Found is reachable from the member and admin apps and stays lazy", async () => {
  const { readFile } = await import("node:fs/promises");
  const { ADMIN_DESTINATIONS, MEMBER_DESTINATIONS, findTools } = await import("../src/shared/app-navigation.js");
  assert.ok(MEMBER_DESTINATIONS.some((row) => row.key === "lost-found" && row.group === "more" && row.label === "Lost & Found"));
  assert.ok(ADMIN_DESTINATIONS.some((row) => row.key === "lost-found" && row.group === "more"));
  assert.equal(findTools("lost disc")[0]?.key, "lost-found", "Find a tool finds it");
  assert.equal(findTools("karma")[0]?.key, "lost-found");
  const publicMain = await readFile(new URL("../src/public-app/main.js", import.meta.url), "utf8");
  assert.match(publicMain, /import\("\.\/lf-app\.js"\)/);
  assert.doesNotMatch(publicMain, /from "\.\/lf-/, "other public pages never load Lost & Found code");
  const dashboard = await readFile(new URL("../src/members-app/dashboard-app.js", import.meta.url), "utf8");
  assert.match(dashboard, /lazyPanel\(\(\) => import\("\.\/lost-found-panel\.js"\), "MemberLostFoundPage"\)/);
  const home = await readFile(new URL("../src/members-app/overview-dashboard.js", import.meta.url), "utf8");
  assert.match(home, /React\.lazy\(\(\) => import\("\.\/returned-home-card\.js"\)/, "the Home card's code is a lazy chunk");
  const more = await readFile(new URL("../src/members-app/more-page.js", import.meta.url), "utf8");
  assert.match(more, /title: "On the course"[\s\S]*tab: "lost-found"[\s\S]*title: "Club sites"/, "Club > On the course has the row");
  const admin = await readFile(new URL("../admin.html", import.meta.url), "utf8");
  assert.match(admin, /id="apane-lost-found"/);
  const page = await readFile(new URL("../lost-found.html", import.meta.url), "utf8");
  assert.match(page, /<body data-public-polish="shop" data-auth-base="" data-page="lost-found">/);
  assert.match(page, /<div id="lostFoundReactApp"><\/div>/);
});

test("photo copy: photos are public, the tip says how to cover writing, and nothing promises blurring", async () => {
  const model = await import("../src/shared/lost-found-model.js");
  assert.match(model.LF_PHOTO_TIP, /^Photos are public\./);
  assert.match(model.LF_PHOTO_TIP, /thumb or a strip of tape/);
  assert.equal(model.LF_NUDGE_TEXT, "This photo may show a name or phone number, and anyone can see it.");
  for (const value of Object.values(model)) {
    const text = typeof value === "string" ? value : value && typeof value === "object" ? JSON.stringify(value) : "";
    assert.doesNotMatch(text, /blur|redact/i);
  }
});

test("editing a post: its route, the form filled back in, and cleared fields sent as null", async () => {
  const model = await import("../src/shared/lost-found-model.js");
  assert.deepEqual((({ view, id }) => ({ view, id }))(model.parseLfRoute("#edit/12")), { view: "edit", id: 12 });
  assert.equal(model.parseLfRoute("#edit/x").view, "list");
  assert.equal(model.editHref(12), "#edit/12");
  assert.equal(model.splitArea("Hole 7 · by the pond", 7), "by the pond");
  assert.equal(model.splitArea("Hole 7", 7), "");
  assert.equal(model.splitArea("Hole 7 · by the pond", 8), "Hole 7 · by the pond");
  assert.equal(model.splitArea("Parking lot", null), "Parking lot");
  const draft = model.draftFromPost({
    kind: "lost", brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", weightG: 175, course: { id: 9, name: "Elm" }, hole: 7,
    area: "Hole 7 · by the pond", date: "2026-11-10", rewardNote: "Pizza", privateInk: "Ada 252", holding: null, binNote: "",
  });
  assert.deepEqual(draft, {
    brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", weightG: "175", courseId: "9", hole: "7", area: "by the pond",
    eventDate: "2026-11-10", holding: "finder", binNote: "", rewardNote: "Pizza", privateInk: "Ada 252",
  });
  // Saved back unchanged, it composes the same area again.
  assert.equal(model.postEditPayload("lost", draft).area, "Hole 7 · by the pond");
  const cleared = model.postEditPayload("lost", { ...draft, courseId: "", hole: "", weightG: "", eventDate: "" });
  assert.deepEqual([cleared.courseId, cleared.hole, cleared.weightG, cleared.eventDate], [null, null, null, null]);
  assert.equal("photos" in cleared, false);
  assert.equal("kind" in cleared, false);
});
