import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { recordMemberNotices } from "../src/member-messages.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

const member = (memberId: string, name: string) =>
  JSON.stringify({ memberId, name, isAdmin: false, pinHash: "secret-pin", mustChangePin: false });

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string }) => ({
      keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return {
    raw: db,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() {
          const info = db.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true, meta: { changes: info.changes } };
        },
      };
      return stmt;
    },
  };
}

function makeEnv(db: Awaited<ReturnType<typeof sqliteDb>>): Env {
  return {
    ROSTER: kv({
      "member:m_ada": member("m_ada", "Ada Lovelace"),
      "member:m_bo": member("m_bo", "Bo Burnham"),
      "member:m_cy": member("m_cy", "Cy Young"),
    }),
    RATELIMIT: kv(),
    DB: db,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
  } as unknown as Env;
}

const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

async function call(env: Env, path: string, method = "GET", bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const response = await worker.fetch(new Request("https://worker.example" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx as ExecutionContext);
  const data: any = await response.json().catch(() => null);
  await Promise.all(pending);
  return { status: response.status, data };
}

describe("member messages and notices", () => {
  it("lets two members exchange a message, hides it from everyone else, and clears unread when opened", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const ada = await token("m_ada");
    const bo = await token("m_bo");
    const cy = await token("m_cy");

    const sent = await call(env, "/me/messages", "POST", ada, { to: "m_bo", body: "  Tee time Sunday?  " });
    expect(sent.status).toBe(201);
    expect(sent.data.message.body).toBe("Tee time Sunday?");
    const threadId = sent.data.threadId;

    const adaInbox = await call(env, "/me/messages", "GET", ada);
    expect(adaInbox.data.unread).toBe(0);
    expect(adaInbox.data.threads[0].with).toEqual({ memberId: "m_bo", name: "Bo Burnham" });
    expect(JSON.stringify(adaInbox.data)).not.toContain("secret-pin");

    const boSummary = await call(env, "/me/messages/summary", "GET", bo);
    expect(boSummary.data).toEqual({ unread: 1, unseen: 0, market: 0, lostFound: { waiting: 0, recent: [] } });
    const notice = db.raw.prepare("SELECT member_id, kind, title FROM member_notices").all();
    expect(notice).toEqual([{ member_id: "m_bo", kind: "message", title: "Ada Lovelace" }]);

    expect((await call(env, "/me/messages/" + threadId, "GET", cy)).status).toBe(404);
    expect((await call(env, "/me/messages/" + threadId, "POST", cy, { body: "nope" })).status).toBe(404);

    const opened = await call(env, "/me/messages/" + threadId, "GET", bo);
    expect(opened.status).toBe(200);
    expect(opened.data.messages.map((row: { body: string }) => row.body)).toEqual(["Tee time Sunday?"]);
    expect(opened.data.unread).toBe(0);
    expect(opened.data.thread.with.name).toBe("Ada Lovelace");
    const seen = db.raw.prepare("SELECT seen_at FROM member_notices").get() as { seen_at: string | null };
    expect(seen.seen_at).toBeTruthy();

    const reply = await call(env, "/me/messages/" + threadId, "POST", bo, { body: "I'm in." });
    expect(reply.status).toBe(201);
    expect((await call(env, "/me/messages/summary", "GET", ada)).data.unread).toBe(1);
  });

  it("rejects a message to yourself, an empty body, and a burst over the hourly limit", async () => {
    const env = makeEnv(await sqliteDb());
    const ada = await token("m_ada");
    expect((await call(env, "/me/messages", "POST", ada, { to: "m_ada", body: "hi" })).status).toBe(400);
    expect((await call(env, "/me/messages", "POST", ada, { to: "m_bo", body: "   " })).status).toBe(400);
    expect((await call(env, "/me/messages", "POST", ada, { to: "missing", body: "hi" })).status).toBe(404);
    await env.RATELIMIT.put("dm:m_ada", "30");
    expect((await call(env, "/me/messages", "POST", ada, { to: "m_bo", body: "one more" })).status).toBe(429);
  });

  it("searches other members without returning the caller or a pin", async () => {
    const env = makeEnv(await sqliteDb());
    const found = await call(env, "/me/messages/people?q=ada", "GET", await token("m_bo"));
    expect(found.status).toBe(200);
    expect(found.data.people).toEqual([{ memberId: "m_ada", name: "Ada Lovelace" }]);
    const self = await call(env, "/me/messages/people?q=ada", "GET", await token("m_ada"));
    expect(self.data.people).toEqual([]);
    expect(JSON.stringify(found.data)).not.toContain("pin");
  });

  it("caches /me/messages/people in D1, invalidates when roster_recent changes, and rate-limits bursts", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    let listCalls = 0;
    const realList = env.ROSTER.list.bind(env.ROSTER);
    env.ROSTER.list = async (opts) => { listCalls += 1; return realList(opts); };

    const bo = await token("m_bo");
    expect((await call(env, "/me/messages/people?q=ada", "GET", bo)).data.people).toHaveLength(1);
    expect(listCalls).toBe(1);
    expect((await call(env, "/me/messages/people?q=cy", "GET", bo)).data.people).toHaveLength(1);
    expect(listCalls).toBe(1);

    // Updating a member via ConsistentKV updates roster_recent and busts people_cache.
    db.raw.prepare("INSERT INTO kv_store (ns, key, value, expires_at) VALUES ('roster_recent', 'member:m_new', ?, ?)")
      .run(JSON.stringify({ op: "put", value: JSON.stringify({ memberId: "m_new", name: "New Member", pinVer: 0 }) }), Date.now() + 180_000);
    expect((await call(env, "/me/messages/people?q=ada", "GET", bo)).status).toBe(200);
    expect(listCalls).toBe(2);

    // Rate limits past 30 calls/min.
    let limited = 0;
    for (let i = 0; i < 30; i += 1) {
      if ((await call(env, "/me/messages/people?q=ada", "GET", bo)).status === 429) { limited = 429; break; }
    }
    expect(limited).toBe(429);
  });

  it("keeps a bag-tag update in the notice list until the member marks it seen", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    await recordMemberNotices(env, ["m_bo"], {
      kind: "bag-tag",
      title: "Ada challenged your #4",
      body: "Tap to confirm or decline.",
      href: "/gvdg-members.html#tags",
      refKey: "bag-challenge:9:created",
    });
    const bo = await token("m_bo");
    const summary = await call(env, "/me/messages/summary", "GET", bo);
    expect(summary.data).toEqual({ unread: 0, unseen: 1, market: 0, lostFound: { waiting: 0, recent: [] } });
    const listed = await call(env, "/me/notices", "GET", bo);
    expect(listed.data.notices).toHaveLength(1);
    expect(listed.data.notices[0].kind).toBe("bag-tag");
    expect(listed.data.notices[0].seen).toBe(false);
    const seen = await call(env, "/me/notices/seen", "POST", bo, { ids: [listed.data.notices[0].id] });
    expect(seen.data).toMatchObject({ ok: true, unseen: 0 });
    expect((await call(env, "/me/notices", "GET", bo)).data.notices[0].seen).toBe(true);
  });
});
