import { handicapKey } from "../src/handicap.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { D1Like } from "../src/db-types.js";
import type { Env } from "../src/env.js";
import { handleCommunityRoute } from "../src/community-routes.js";
import { communityProgress } from "../src/community-progress.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";

const SECRET = "c".repeat(40);
const ORIGIN = "https://gvdgclub.com";
const memberIds = ["m_alex", "m_bailey", "m_staff"];
type Member = typeof memberIds[number];

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_init.sql", "0016_casual_rounds.sql", "0048_course_discovery.sql", "0054_community_discovery.sql", "0084_community_share_pdga.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  sqlite.exec("INSERT INTO courses (id, name) VALUES (1, 'Riverside'), (2, 'Woodland'), (3, 'County Park')");
  type Bound = { sql: string; values: unknown[] };
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) { statement.values = values; return statement; },
        async all() { return { results: sqlite.prepare(sql).all(...statement.values), success: true }; },
        async first() { return sqlite.prepare(sql).get(...statement.values) || null; },
        async run() { return { results: [], success: true, meta: sqlite.prepare(sql).run(...statement.values) }; },
      };
      return statement;
    },
    async batch(statements: Bound[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, values }) => ({ results: sqlite.prepare(sql).all(...values), success: true }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Like;
  const rate = new Map<string, string>();
  const roster = new Set(memberIds);
  const env = {
    DB: db, JWT_SECRET: SECRET,
    ROSTER: { get: async (key: string) => roster.has(key.slice(7)) ? JSON.stringify({ memberId: key.slice(7), name: "Private roster name", pdgaNo: key === "member:m_alex" ? "80024" : undefined, pinVer: 3, isAdmin: key === "member:m_staff" }) : null },
    RATELIMIT: { get: async (key: string) => rate.get(key), put: async (key: string, value: string) => rate.set(key, value) },
  } as unknown as Env;
  const tokens = new Map(await Promise.all(memberIds.map(async (member) => [member, await signSession({ sub: member, mustChangePin: false, pinVer: 3 }, SECRET, 900)] as const)));
  const open = await signOpenPlaySession({ sub: "op_guest", name: "Guest" }, SECRET, 900);
  async function api(path: string, member: Member | null = "m_alex", method = "GET", payload?: unknown) {
    const url = new URL(path, ORIGIN);
    const token = member === "open" ? open : member && tokens.get(member);
    const headers = token ? { Authorization: "Bearer " + token } : undefined;
    const request = new Request(url, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return (await handleCommunityRoute(request, env, ORIGIN, url.pathname, method))!;
  }
  async function profile(member: Member, audience: string, name: string, revision = 0, shareProgress = false) {
    const response = await api("/me/community/profile", member, "PUT", { audience, displayName: name, bio: "Putter collector", shareProgress, revision });
    expect(response.status).toBe(200);
    return (await response.json() as { profile: { key: string; revision: number } }).profile;
  }
  return { api, profile, sqlite, db, rate, roster };
}

describe("community visibility and consent", () => {
  it("does not publish a profile until opt-in, publishes only whitelisted fields and revokes old links", async () => {
    const { api, profile, roster } = await fixture();
    const fresh = await api("/me/community");
    expect(await fresh.json()).toMatchObject({
      profile: { key: null, audience: "private", shareProgress: false },
      progress: { totals: { club: 0, casual: 0 }, streak: 0, achieved: [] },
    });
    expect(await (await api("/community/directory", "m_bailey")).json()).toMatchObject({ profiles: [] });
    expect((await api("/community/directory", "open")).status).toBe(401);
    expect((await api("/me/community/profile", "m_alex", "PUT", { audience: "public", displayName: "", bio: "", revision: 0, shareProgress: false })).status).toBe(400);
    expect((await api("/me/community/profile", "m_alex", "PUT", { audience: "public", displayName: "Alex", bio: "", revision: 0, shareProgress: false, memberId: "m_bailey" })).status).toBe(400);
    const published = await profile("m_alex", "public", "Garden Disc");
    const link = "/community/profiles/" + published.key;
    const publicResponse = await api(link, null);
    expect(publicResponse.headers.get("Cache-Control")).toBe("private, no-store");
    const publicBody = await publicResponse.json();
    // karmaKey is the karma directory's anonymous key (as live scoring's handicapKeys), never the member id.
    expect(publicBody).toEqual({ profile: { key: published.key, audience: "public", displayName: "Garden Disc", bio: "Putter collector", progress: null, karmaKey: handicapKey("m_alex") } });
    expect(JSON.stringify(publicBody)).not.toContain("m_alex");
    const expiredCopy = { audience: "public", displayName: "Garden Disc", bio: "Putter collector", shareProgress: false, revision: 0 };
    expect((await api("/me/community/profile", "m_alex", "PUT", expiredCopy)).status).toBe(200);
    await profile("m_alex", "private", "Garden Disc", published.revision, true);
    expect((await api(link, null)).status).toBe(404);
    expect((await api(link, "m_staff")).status).toBe(404);
    expect((await api("/me/community/profile", "m_alex", "PUT", expiredCopy)).status).toBe(409);
    const restored = await profile("m_alex", "public", "Garden Disc", published.revision + 1, true);
    expect(restored.key).not.toBe(published.key);
    expect((await api(link, null)).status).toBe(404);
    const newLink = "/community/profiles/" + restored.key;
    expect(await (await api(newLink, null)).json()).toMatchObject({ profile: { progress: { total: 0 } } });
    roster.delete("m_alex");
    expect((await api(newLink, null)).status).toBe(404);
  });

  it("allows only the receiver to accept, removes connections on either block and enforces audience on links", async () => {
    const { api, profile, sqlite } = await fixture();
    const a = await profile("m_alex", "friends", "Alex");
    const b = await profile("m_bailey", "club", "Bailey");
    const aLink = "/community/profiles/" + a.key;
    const bLink = "/community/profiles/" + b.key;
    const request = (actor: Member, target: string, action: string) => api("/me/community/connections/" + target, actor, "PUT", { action });
    expect((await api(aLink, "m_bailey")).status).toBe(404);
    expect((await api(bLink, null)).status).toBe(404);
    await request("m_alex", b.key, "request");
    await request("m_alex", b.key, "request");
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_connections").get()?.n).toBe(1);
    expect((await request("m_alex", b.key, "accept")).status).toBe(409);
    expect(await (await request("m_bailey", a.key, "accept")).json()).toMatchObject({ contacts: [{ displayName: "Alex", relation: "friend" }] });
    expect((await request("m_bailey", a.key, "accept")).status).toBe(200);
    expect((await api(aLink, "m_bailey")).status).toBe(200);
    expect((await request("m_alex", b.key, "block")).status).toBe(200);
    expect((await request("m_alex", b.key, "block")).status).toBe(200);
    expect((await api(aLink, "m_bailey")).status).toBe(404);
    expect((await api(bLink, "m_alex")).status).toBe(404);
    expect((await request("m_alex", b.key, "request")).status).toBe(409);
    expect((await request("m_bailey", a.key, "request")).status).toBe(409);
    expect((await request("m_bailey", a.key, "unblock")).status).toBe(200);
    expect((await api(bLink, "m_alex")).status).toBe(404);
    expect((await request("m_alex", b.key, "unblock")).status).toBe(200);
    expect((await api(bLink, "m_alex")).status).toBe(200);
    expect((await request("m_alex", b.key, "request")).status).toBe(200);
    expect((await request("m_bailey", a.key, "remove")).status).toBe(200);
    expect((await request("m_bailey", a.key, "remove")).status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_connections").get()?.n).toBe(0);
  });

  it("counts one placed result per finalized GVDG round and uses New York weeks", async () => {
    const { db, sqlite } = await fixture();
    sqlite.exec(`
      INSERT INTO events(id,type,name,status,date) VALUES
        (1,'tournament','Actual rounds','final','2026-11-09'),
        (2,'tournament','Still on course','live','2026-11-10'),
        (3,'league_round','Incomplete','final','2026-11-03'),
        (4,'league_round','Wrong date result','final','2026-11-22');
      INSERT INTO results(event_id,member_id,name,place) VALUES
        (1,'m_alex','Alex',1),(1,'m_alex','Alex duplicate',1),(1,'m_bailey','Bailey',2),
        (2,'m_alex','Alex',1),(3,'m_alex','Alex',NULL),(4,'m_alex','Alex',1);
      INSERT INTO casual_rounds(id,round_code,started_at) VALUES
        (1,'MIDNIGHT','2026-11-09T03:30:00Z'),
        (2,'SHORT','2026-11-10T13:00:00Z');
      INSERT INTO casual_results(casual_round_id,member_id,name,place) VALUES
        (1,'m_alex','Alex',1),(1,'m_alex','Alex duplicate',1),(2,'m_alex','Alex',NULL);
    `);
    const progress = await communityProgress(db, "m_alex", Date.parse("2026-11-14T02:00:00Z"));
    expect(progress.totals).toEqual({ club: 1, casual: 1 });
    expect(progress.streak).toBe(2);
    expect(progress.weekly.slice(-2)).toEqual([{ startsOn: "2026-11-02", rounds: 1 }, { startsOn: "2026-11-09", rounds: 1 }]);
    expect(progress.achieved).toEqual([1]);
    expect(progress.next).toBe(5);
  });
});

describe("course discovery and moderated reviews", () => {
  it("filters confirmed no separately from unknown and preserves account favorites", async () => {
    const { api, sqlite } = await fixture();
    const unknown = { restrooms: "unknown", drinkingWater: "unknown", practiceBasket: "unknown", accessibleParking: "unknown", stepFreeRoute: "unknown" };
    const data = { difficulty: "beginner", amenities: { ...unknown, restrooms: "no", accessibleParking: "yes" }, notes: "Parking by the shelter.", revision: 0 };
    expect((await api("/admin/community/courses/1", "m_alex", "PUT", data)).status).toBe(403);
    expect((await api("/admin/community/courses/1", "m_staff", "PUT", data)).status).toBe(200);
    expect((await api("/admin/community/courses/1", "m_staff", "PUT", data)).status).toBe(200);
    expect(await (await api("/community/courses?restrooms=no", null)).json()).toMatchObject({ courses: [{ id: 1, amenities: { restrooms: "no" }, difficulty: "beginner" }] });
    const missing = await (await api("/community/courses?restrooms=unknown", null)).json() as { courses: { id: number }[] };
    expect(missing.courses.map(({ id }) => id)).toEqual([3, 2]);
    sqlite.exec("INSERT INTO member_course_favorites VALUES ('m_alex',1,datetime('now')), ('m_bailey',2,datetime('now'))");
    expect((await api("/community/courses?favorites=1", null)).status).toBe(401);
    expect(await (await api("/community/courses?favorites=1", "m_alex")).json()).toMatchObject({ courses: [{ id: 1 }] });
    expect(await (await api("/community/courses?favorites=1", "m_bailey")).json()).toMatchObject({ courses: [{ id: 2 }] });
  });

  it("publishes only reviewed versions, accepts an idempotent report and removes text only for its owner", async () => {
    const { api } = await fixture();
    const review = "/me/community/courses/1/review";
    const publicRoute = "/community/courses/1/reviews";
    const original = { rating: 4, text: "Quiet park.", revision: 0 };
    expect(await (await api(review, "m_alex", "PUT", original)).json()).toMatchObject({ mine: { id: 1, revision: 1, state: "pending" } });
    expect(await (await api(publicRoute, null)).json()).toMatchObject({ reviews: [], mine: null, course: { reviewCount: 0 } });
    expect((await api("/admin/community/reviews", "m_bailey")).status).toBe(403);
    expect(await (await api("/admin/community/reviews", "m_staff")).json()).toMatchObject({ queue: [{ id: 1, text: "Quiet park.", reportCount: 0 }] });
    expect((await api("/admin/community/reviews/1", "m_staff", "PUT", { action: "approve", revision: 1 })).status).toBe(200);
    expect(await (await api(review, "m_alex", "PUT", original)).json()).toMatchObject({ mine: { state: "published", revision: 1 } });
    expect(await (await api(publicRoute, null)).json()).toMatchObject({ reviews: [{ rating: 4, text: "Quiet park.", own: false }], course: { reviewCount: 1, averageRating: 4 } });
    const report = "/me/community/reviews/1/report";
    expect((await api(report, "m_alex", "PUT", { revision: 1, reason: "unsafe" })).status).toBe(404);
    expect((await api(report, "m_bailey", "PUT", { revision: 1, reason: "unsafe" })).status).toBe(200);
    expect((await api(report, "m_bailey", "PUT", { revision: 1, reason: "abuse" })).status).toBe(200);
    expect(await (await api("/admin/community/reviews", "m_staff")).json()).toMatchObject({ queue: [{ id: 1, reportCount: 1, reasons: "unsafe" }] });
    expect((await api(review, "m_bailey", "DELETE", { revision: 1 })).status).toBe(200);
    expect(await (await api(publicRoute, null)).json()).toMatchObject({ reviews: [{ id: 1 }] });
    await api(review, "m_alex", "PUT", { rating: 3, text: "Crowded.", revision: 1 });
    expect((await api("/admin/community/reviews/1", "m_staff", "PUT", { action: "approve", revision: 1 })).status).toBe(409);
    expect(await (await api(publicRoute, null)).json()).toMatchObject({ reviews: [] });
    expect((await api("/admin/community/reviews/1", "m_staff", "PUT", { action: "hide", revision: 2 })).status).toBe(200);
    expect((await api(review, "m_alex", "DELETE", { revision: 2 })).status).toBe(200);
    expect(await (await api(publicRoute, "m_alex")).json()).toMatchObject({ reviews: [], mine: { state: "removed", text: "", rating: null } });
  });

  it("shares linked PDGA number on community profiles only when opted in", async () => {
    const { api } = await fixture();
    const first = await api("/me/community/profile", "m_alex", "PUT", {
      audience: "public", displayName: "Ada PDGA", bio: "", shareProgress: false, sharePdga: true, revision: 0,
    });
    expect(first.status).toBe(200);
    const saved = (await first.json() as { profile: { key: string; sharePdga: boolean; revision: number } }).profile;
    expect(saved.sharePdga).toBe(true);
    const publicView = await api("/community/profiles/" + saved.key, null);
    expect(publicView.status).toBe(200);
    expect(await publicView.json()).toMatchObject({ profile: { displayName: "Ada PDGA", pdgaNo: "80024" } });

    const off = await api("/me/community/profile", "m_alex", "PUT", {
      audience: "public", displayName: "Ada PDGA", bio: "", shareProgress: false, sharePdga: false, revision: saved.revision,
    });
    expect(off.status).toBe(200);
    const unshared = await (await api("/community/profiles/" + saved.key, null)).json() as { profile: Record<string, unknown> };
    expect("pdgaNo" in unshared.profile).toBe(false);
  });

  it("enforces per-account limits and rejects overlong mutation requests", async () => {
    const { api, rate } = await fixture();
    rate.set("community:profile:m_alex", "20");
    expect((await api("/me/community/profile", "m_alex", "PUT", { audience: "private", displayName: "", bio: "", shareProgress: false, revision: 0 })).status).toBe(429);
    expect((await api("/me/community/profile", "m_bailey", "PUT", { input: "x".repeat(7000) })).status).toBe(413);
  });
});
