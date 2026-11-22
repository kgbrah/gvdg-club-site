import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validatePost } from "../src/shared/lost-found-model.js";
import {
  clearMemberSession,
  memberTokenExpired,
  memberTokenSubject,
} from "../src/shared/member-session.js";
import { reportDonation } from "../src/shared/donate-prompt.js";
import { bagPickChoices, readBagHandoff } from "../src/public-app/lf-bag.js";
import { readMarketBagHandoff, sellFromBag } from "../src/public-app/market-bag.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

function fakeJwt(payload) {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.sig`;
}

test("lost-found validatePost enforces weightG, rewardNote, binNote, and eventDate (respecting keepEventDate)", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  assert.equal(validatePost("found", { weightG: "175" }, 1, { now }), null);
  assert.equal(validatePost("found", { weightG: "99" }, 1, { now }).field, "weightG");
  assert.equal(validatePost("found", { weightG: "201" }, 1, { now }).field, "weightG");
  assert.equal(validatePost("found", { weightG: "175.5" }, 1, { now }).field, "weightG");
  assert.equal(validatePost("lost", { mold: "Buzzz", rewardNote: "r".repeat(81) }, 0, { now }).field, "rewardNote");
  assert.equal(validatePost("found", { holding: "club_bin", binNote: "b".repeat(81) }, 1, { now }).field, "binNote");
  assert.equal(validatePost("found", { eventDate: "2026-02-30" }, 1, { now }).field, "eventDate");
  assert.equal(validatePost("found", { eventDate: "2026-12-01" }, 1, { now }).field, "eventDate");
  assert.equal(validatePost("found", { eventDate: "2025-10-01" }, 1, { now }).field, "eventDate");
  assert.equal(validatePost("found", { eventDate: "2025-10-01" }, 1, { keepEventDate: true, now }), null);
});

test("memberTokenExpired handles fresh, expired, missing exp, and malformed JWTs cleanly", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const fresh = fakeJwt({ sub: "m_1", exp: nowSec + 300 });
  const expired = fakeJwt({ sub: "m_1", exp: nowSec - 10 });
  assert.equal(memberTokenExpired(fresh), false);
  assert.equal(memberTokenExpired(expired), true);
  assert.equal(memberTokenExpired(fakeJwt({ sub: "m_1" })), false);
  assert.equal(memberTokenExpired("not-a-jwt"), false);
  assert.equal(memberTokenSubject(fresh), "m_1");
});

test("clearMemberSession wipes L&F and Market bag handoff keys", () => {
  const prevLocal = globalThis.localStorage;
  const prevSession = globalThis.sessionStorage;
  const local = memoryStorage({
    gvdg_member_token: "tok",
    gvdg_lf_bag_handoff: "{\"discId\":\"a\"}",
    gvdg_market_bag_handoff: "{\"discId\":\"b\"}",
  });
  const session = memoryStorage({
    gvdg_lf_bag_handoff: "{\"discId\":\"a\"}",
    gvdg_market_bag_handoff: "{\"discId\":\"b\"}",
  });
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  try {
    clearMemberSession();
    assert.equal(local.getItem("gvdg_member_token"), null);
    assert.equal(local.getItem("gvdg_lf_bag_handoff"), null);
    assert.equal(local.getItem("gvdg_market_bag_handoff"), null);
    assert.equal(session.getItem("gvdg_lf_bag_handoff"), null);
    assert.equal(session.getItem("gvdg_market_bag_handoff"), null);
  } finally {
    globalThis.localStorage = prevLocal;
    globalThis.sessionStorage = prevSession;
  }
});

test("donate-prompt reads member token via readMemberToken (including sessionStorage fallback)", async () => {
  const prevLocal = globalThis.localStorage;
  const prevSession = globalThis.sessionStorage;
  const local = memoryStorage();
  const session = memoryStorage({ gvdg_member_token: fakeJwt({ sub: "m_fallback", exp: Math.floor(Date.now() / 1000) + 600 }) });
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  try {
    let seenAuth = "";
    const res = await reportDonation(500, "round", {
      base: "https://auth.example",
      fetchImpl: async (_url, init) => {
        seenAuth = init.headers.Authorization;
        return new Response(JSON.stringify({ donation: { id: 1, amountCents: 500 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    assert.equal(res.ok, true);
    assert.match(seenAuth, /^Bearer /);
  } finally {
    globalThis.localStorage = prevLocal;
    globalThis.sessionStorage = prevSession;
  }
});

test("bag handoffs reject and wipe foreign ownerSub while unlocking returned lost posts", () => {
  const prevLocal = globalThis.localStorage;
  const prevSession = globalThis.sessionStorage;
  const local = memoryStorage();
  const session = memoryStorage();
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  try {
    const discId = "11111111-1111-4111-8111-111111111111";
    session.setItem("gvdg_lf_bag_handoff", JSON.stringify({ ownerSub: "m_other", discId, brand: "Innova", mold: "Wraith" }));
    assert.equal(readBagHandoff("m_me"), null);
    assert.equal(session.getItem("gvdg_lf_bag_handoff"), null, "foreign L&F handoff is wiped");

    session.setItem("gvdg_lf_bag_handoff", JSON.stringify({ ownerSub: "m_me", discId, brand: "Innova", mold: "Wraith" }));
    assert.equal(readBagHandoff("m_me")?.discId, discId);

    const choices = bagPickChoices(
      { discs: [{ id: discId, revision: 1, record: { brand: "Innova", model: "Wraith", inBag: true } }] },
      { lost: [{ discId, postId: 9, status: "returned" }] },
    );
    assert.equal(choices.length, 1);

    const prevWindow = globalThis.window;
    globalThis.window = { location: { href: "" } };
    try {
      sellFromBag({ ref: "disc:" + discId, brand: "Innova", mold: "Wraith", ownerSub: "m_other" });
      assert.equal(readMarketBagHandoff("m_me"), null);
      assert.equal(session.getItem("gvdg_market_bag_handoff"), null, "foreign market handoff is wiped");

      sellFromBag({ ref: "disc:" + discId, brand: "Innova", mold: "Wraith", ownerSub: "m_me" });
      assert.equal(readMarketBagHandoff("m_me")?.ref, "disc:" + discId);
    } finally {
      globalThis.window = prevWindow;
    }
  } finally {
    globalThis.localStorage = prevLocal;
    globalThis.sessionStorage = prevSession;
  }
});

test("Batch 5 UI components preserve hooks order, error retries, navigation cleanup, and a11y contracts", () => {
  const camera = readFileSync("src/public-app/camera-sheet.js", "utf8");
  assert.match(camera, /mountedHref/);
  assert.match(camera, /window\.addEventListener\("hashchange"/);
  assert.match(camera, /window\.addEventListener\("popstate"/);
  assert.match(camera, /stopStream\(streamRef\.current\)/);

  const fields = readFileSync("src/public-app/disc-fields.js", "utf8");
  assert.match(fields, /choosingOtherRef/);
  assert.match(fields, /setPhase\("starting"\)/);
  assert.match(fields, /disabled:\s*phase === "starting" \|\| phase === "sending"/);
  assert.match(fields, /mountedRef\.current = false/);

  const lfPost = readFileSync("src/public-app/lf-post.js", "utf8");
  assert.match(lfPost, /!match && message\.trim\(\)\.length < 8/);
  assert.match(lfPost, /post\.canEdit && post\.photos\?\.length/);
  assert.match(lfPost, /lastFoundPhoto = post\.kind === "found" && post\.photos\.length <= 1/);
  assert.match(lfPost, /post\.status === "open" \|\| post\.status === "claimed"/);

  const lfWall = readFileSync("src/public-app/lf-wall.js", "utf8");
  assert.match(lfWall, /No karma yet\./);
  assert.match(lfWall, /\+10 per dollar/);

  const apply = readFileSync("src/members-app/apply-submitted.js", "utf8");
  assert.doesNotMatch(apply, /existing\.unsubscribe\(\)/);

  const notify = readFileSync("src/members-app/notifications-panel.js", "utf8");
  assert.match(notify, /prefs:\s*\{\s*bagTags,\s*messages\s*\}/);
  assert.match(notify, /if\s*\(!removed\.ok\)\s*throw/);
  assert.match(notify, /if\s*\(!json\?\.endpoint\)\s*throw/);

  const playStats = readFileSync("src/members-app/play-stats-panel.js", "utf8");
  assert.match(playStats, /role:\s*"group"/);
  assert.doesNotMatch(playStats, /role:\s*"tablist"/);
  assert.match(playStats, /function PlayStatsPanelBody/);
  assert.match(playStats, /if\s*\(historyLocked\(context\)\)/);

  const playPage = readFileSync("src/members-app/play-page.js", "utf8");
  assert.match(playPage, /function UdiscHistoryBody/);
  assert.match(playPage, /Could not load UDisc history\./);
  assert.match(playPage, /Could not load club handicap\./);

  const overview = readFileSync("src/members-app/overview-dashboard.js", "utf8");
  assert.match(overview, /function LastRoundCardBody/);
  assert.match(overview, /Could not load your last round\./);

  const ratings = readFileSync("src/members-app/club-ratings.js", "utf8");
  assert.match(ratings, /data-react-club-ratings.*error|state\.status === "error"/);
  assert.match(ratings, /Try again/);

  const conditions = readFileSync("src/members-app/course-conditions-panel.js", "utf8");
  assert.match(conditions, /setFailed\(hadError\)/);
  assert.match(conditions, /Try again/);

  const bagTag = readFileSync("src/members-app/bag-tag-panel.js", "utf8");
  assert.match(bagTag, /data-bag-tag-state":\s*"error"/);
  assert.match(bagTag, /challengerId[\s\S]*KarmaChip/);

  const msgs = readFileSync("src/members-app/messages-panel.js", "utf8");
  assert.match(msgs, /dashboardShowing\("messages"\)/);
  assert.match(msgs, /h\("ul",\s*\{\s*className:\s*"member-list-rows"/);
  assert.doesNotMatch(msgs, /role:\s*"listitem"/);

  const inbox = readFileSync("src/members-app/inbox-summary.js", "utf8");
  assert.match(inbox, /if\s*\(!document\.hidden\)/);

  const mainPublic = readFileSync("src/public-app/main.js", "utf8");
  assert.match(mainPublic, /resolveApiBase\(\{\s*datasetKeys:\s*\["authBase"\]\s*\}\)/);

  const shop = readFileSync("src/public-app/pro-shop-app.js", "utf8");
  assert.match(shop, /key:\s*"identity-"\s*\+\s*section/);
  assert.match(shop, /key:\s*"market-"\s*\+\s*section/);

  const membersHtml = readFileSync("gvdg-members.html", "utf8");
  assert.doesNotMatch(membersHtml, /--text-color/);

  const more = readFileSync("src/members-app/more-page.js", "utf8");
  assert.match(more, /Guest account/);
});
