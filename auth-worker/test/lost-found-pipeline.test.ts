// Lost & Found pipeline order and cost, built for the Workers Free plan (10 ms CPU per invocation, cron included;
// a CPU-limit kill can't be caught). The Worker does I/O only; photos are public as uploaded; matching and
// notices never depend on a photo; the cron does the cheap work first.
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import { MAX_ATTEMPTS, TICK_READS, processPost, runLostFoundTick } from "../src/lf-process.js";
import { createHarness, dataUrl, inkReply, testJpeg, today } from "./lf-harness.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;
let t: Harness;

const INK = inkReply([
  { text: "WENDY SMITH", type: "name" },
  { text: "252 555 0199", type: "phone" },
]);

function foundBody(photo = t.photo) {
  return { kind: "found", color: "Orange", courseId: 9001, area: "Hole 7", eventDate: today(), photos: [photo] };
}

async function wendyLostPost() {
  const wendy = await t.guestToken("wendy@example.test", "Wendy Guest");
  const res = await t.call("/lost-found/posts", "POST", wendy, {
    kind: "lost", brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", courseId: 9001, eventDate: today(-1),
    privateInk: "Wendy Smith 252-555-0199",
  });
  expect(res.status).toBe(201);
  return wendy;
}

function photoOf(postId: number) {
  return t.db.raw.prepare("SELECT id, status, read_state, attempts, last_error, nudge FROM lf_photos WHERE post_id = ?").get(postId) as
    { id: number; status: string; read_state: string; attempts: number; last_error: string; nudge: string };
}

function due() {
  t.db.raw.prepare("UPDATE lf_photos SET next_attempt_at = datetime('now', '-1 minute') WHERE read_state = 'pending'").run();
}

/** Posting limits (6 an hour per person) would stop a test that sets up many posts. */
function freshPostingLimits() {
  for (const key of [...(t.env.RATELIMIT as unknown as { rows?: Map<string, string> }).rows?.keys() ?? []]) if (key.startsWith("lfpost")) void t.env.RATELIMIT.delete(key);
}

/** Each loop of a test is "a minute later" for the per-minute vision cap. */
function nextMinute() {
  for (const key of [...(t.env.RATELIMIT as unknown as { rows?: Map<string, string> }).rows?.keys() ?? []]) if (key.startsWith("lfai:m:")) void t.env.RATELIMIT.delete(key);
}

beforeEach(async () => {
  t = await createHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lost & found pipeline order", () => {
  it("shows the photo at once, then reads it, then matches and notifies (and nudges the poster)", async () => {
    await wendyLostPost();
    t.events.length = 0;
    t.gemini.replies = [INK];
    const bo = await t.token("m_bo");
    const created = await t.call("/lost-found/posts", "POST", bo, foundBody());
    expect(created.status).toBe(201);
    const postId = created.data.post.id as number;
    expect(created.data.post.photos).toHaveLength(1);
    // The read comes first, then the owner's notice; no image work happens anywhere.
    expect(t.events.indexOf("gemini")).toBeGreaterThanOrEqual(0);
    expect(t.events.indexOf("email:Is this your disc?")).toBeGreaterThan(t.events.lastIndexOf("gemini"));
    expect(t.db.raw.prepare("SELECT status FROM lf_extractions").get()).toEqual({ status: "ok" });
    expect(t.db.raw.prepare("SELECT status, reasons FROM lf_matches").get()).toMatchObject({ status: "notified", reasons: expect.stringContaining("ink_phone") });
    expect(t.db.raw.prepare("SELECT title FROM member_notices WHERE member_id = 'm_bo'").get()).toEqual({ title: "Someone may own the disc you found" });
    expect(photoOf(postId)).toMatchObject({ status: "public", read_state: "done", attempts: 1, nudge: "shown" });
    // The nudge is the poster's alone and lives only in the app: no email or notice ever mentions it.
    expect(JSON.stringify(t.mail)).not.toMatch(/name or phone|may show/i);
    expect(JSON.stringify(t.db.raw.prepare("SELECT title, body FROM member_notices").all())).not.toMatch(/name or phone|may show/i);
  });

  it("matches even when the photo can't be read at all, and a repeat run doesn't spend another attempt", async () => {
    await wendyLostPost();
    (t.env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = "";
    const created = await t.call("/lost-found/posts", "POST", await t.token("m_bo"), { ...foundBody(), brand: "Innova", mold: "Destroyer", plastic: "Star" });
    expect(t.db.raw.prepare("SELECT status FROM lf_matches").get()).toMatchObject({ status: "notified" });
    expect(photoOf(created.data.post.id)).toMatchObject({ status: "public", read_state: "pending", attempts: 1, last_error: "ai_unavailable" });
    await processPost(t.env, undefined, created.data.post.id);
    expect(photoOf(created.data.post.id).attempts).toBe(1);
  });

  it("claims the attempt before calling the AI, so a killed invocation still counts toward giving up", async () => {
    // A request killed mid-call: the AI never answers. The claim happened first, so the attempt is spent.
    t.gemini.replies = [];
    const hang = vi.spyOn(globalThis, "fetch");
    const original = (globalThis.fetch as unknown as { getMockImplementation(): (...a: unknown[]) => Promise<Response> }).getMockImplementation();
    hang.mockImplementation(async (url, init) => (String(url).startsWith("https://generativelanguage") ? new Promise<Response>(() => {}) : original(url, init)));
    const bo = await t.token("m_bo");
    const created = await Promise.race([t.call("/lost-found/posts", "POST", bo, foundBody()), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
    expect(created).toBeNull();
    const postId = (t.db.raw.prepare("SELECT id FROM lf_posts").get() as { id: number }).id;
    expect(photoOf(postId)).toMatchObject({ read_state: "pending", attempts: 1 });
    for (let i = 0; i < 8; i++) {
      due();
      nextMinute();
      void runLostFoundTick(t.env);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(photoOf(postId)).toMatchObject({ status: "public", read_state: "failed", attempts: MAX_ATTEMPTS });
  });
});

describe("lost & found cron order", () => {
  it("expires and purges first, then reads (bounded) and matches", async () => {
    const bo = await t.token("m_bo");
    const expiring = (await t.call("/lost-found/posts", "POST", bo, foundBody())).data.post.id as number;
    t.db.raw.prepare("UPDATE lf_posts SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(expiring);
    const closed = (await t.call("/lost-found/posts", "POST", bo, foundBody())).data.post.id as number;
    t.db.raw.prepare("UPDATE lf_posts SET status = 'closed' WHERE id = ?").run(closed);
    // Photos the AI couldn't read yet: one on a found post that matches Wendy's lost disc, and more than a tick takes.
    freshPostingLimits();
    await wendyLostPost();
    (t.env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = "";
    const unread = (await t.call("/lost-found/posts", "POST", bo, foundBody())).data.post.id as number;
    const backlog: number[] = [];
    for (let i = 0; i < TICK_READS; i++) {
      freshPostingLimits();
      backlog.push((await t.call("/lost-found/posts", "POST", await t.token("m_admin"), { ...foundBody(), color: "Pink", courseId: null })).data.post.id as number);
    }
    (t.env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = "gk_test";

    t.events.length = 0;
    t.gemini.replies = [INK];
    const seenAtFirstCall: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(globalThis, "fetch");
    const original = (globalThis.fetch as unknown as { getMockImplementation(): (...a: unknown[]) => Promise<Response> }).getMockImplementation();
    spy.mockImplementation(async (url, init) => {
      if (String(url).startsWith("https://generativelanguage") && !seenAtFirstCall.length) {
        seenAtFirstCall.push({
          expired: (t.db.raw.prepare("SELECT status FROM lf_posts WHERE id = ?").get(expiring) as { status: string }).status,
          purged: (t.db.raw.prepare("SELECT photo_key FROM lf_photos WHERE post_id = ?").get(closed) as { photo_key: string | null }).photo_key,
        });
      }
      if (String(url).startsWith("https://generativelanguage")) t.events.push("read");
      return original(url, init);
    });
    due();
    nextMinute();
    // The per-minute cap would stop a real tick after a few calls; lift it here to see the whole order.
    (t.env as unknown as { LF_VISION_PER_MINUTE: string }).LF_VISION_PER_MINUTE = "100";
    const tick = await runLostFoundTick(t.env);

    expect(seenAtFirstCall[0]).toEqual({ expired: "expired", purged: null });
    expect(tick).toMatchObject({ expired: 1, reads: TICK_READS });
    expect(tick.purged).toBe(2);
    expect(tick.matched).toBeGreaterThanOrEqual(1);
    const order = t.events.filter((event) => event === "read" || event === "email:Is this your disc?");
    expect(order.filter((event) => event === "read")).toHaveLength(TICK_READS);
    expect(order.indexOf("email:Is this your disc?")).toBeGreaterThan(0);
    expect(photoOf(unread).read_state).toBe("done");
    expect(backlog.filter((id) => photoOf(id).read_state === "pending")).toHaveLength(1);
    expect(TICK_READS).toBeLessThanOrEqual(4);
  });

  it("runs the market sweep and the UDisc import before Lost & Found in the 15-minute branch", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const branch = source.slice(source.indexOf("if (isUdiscLayoutCron(controller.cron))"), source.indexOf("if (isPdgaEventCron(controller.cron))"));
    const sweep = branch.indexOf("await finalizeWithdrawals(env)");
    const udisc = branch.indexOf("await runUdiscLayoutImportTick(env)");
    const lostFound = branch.indexOf("await runLostFoundTick(env)");
    expect(sweep).toBeGreaterThan(0);
    expect(udisc).toBeGreaterThan(sweep);
    expect(lostFound).toBeGreaterThan(udisc);
    expect(branch.indexOf("if (importError) throw importError")).toBeGreaterThan(lostFound);
  });

  it("still runs Lost & Found when the UDisc import throws, then reports the import failure", async () => {
    const bo = await t.token("m_bo");
    const expiring = (await t.call("/lost-found/posts", "POST", bo, foundBody())).data.post.id as number;
    t.db.raw.prepare("UPDATE lf_posts SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(expiring);
    // Break the UDisc importer's first query (it lists courses; nothing else in this branch does here).
    const db = t.env.DB as unknown as { prepare(sql: string): unknown };
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => (/FROM courses/i.test(sql) ? (() => { throw new Error("import broke"); })() : prepare(sql));
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, t.env,
      { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext);
    const results = await Promise.allSettled(pending);
    expect(t.db.raw.prepare("SELECT status FROM lf_posts WHERE id = ?").get(expiring)).toEqual({ status: "expired" });
    // ...and the import failure is still surfaced to the runtime, as before.
    expect(results.some((r) => r.status === "rejected" && String(r.reason).includes("import broke"))).toBe(true);
  });
});

describe("lost & found CPU budget (Workers Free: 10 ms per invocation)", () => {
  it("has no image codec anywhere in the Worker", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@simplewebauthn/server", "jose"]);
    const dir = new URL("../src/", import.meta.url);
    const offenders = readdirSync(dir).filter((file) => file.endsWith(".ts"))
      .filter((file) => /@cf-wasm|photon|\.wasm\b|ImageDecoder|createImageBitmap|OffscreenCanvas|jpeg-js|\bsharp\b|get_raw_pixels/.test(readFileSync(new URL(file, dir), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("keeps each step cheap, even with a maximum-size photo (create, read, replace, cron tick)", async () => {
    // A 1.2 MB JPEG-shaped file (header + entropy-like bytes): the Worker only checks its header and strips metadata.
    const big = new Uint8Array(1_200_000);
    big.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
      0xff, 0xc0, 0, 17, 8, 0x03, 0xc0, 0x05, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
    for (let i = 52; i < big.length - 2; i++) big[i] = (i * 2654435761) % 255;
    big.set([0xff, 0xd9], big.length - 2);
    const photo = dataUrl(big);
    const bo = await t.token("m_bo");
    const timed = async (path: string, method: string, body?: unknown) => {
      const pending: Promise<unknown>[] = [];
      const headers: Record<string, string> = { Origin: "http://localhost:8080", Authorization: "Bearer " + bo, "CF-Connecting-IP": "203.0.113.9" };
      if (body) headers["Content-Type"] = "application/json";
      const request = new Request("https://worker.example" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const start = performance.now();
      const response = await worker.fetch(request, t.env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext);
      const requestMs = performance.now() - start;
      const bgStart = performance.now();
      await Promise.all(pending);
      return { status: response.status, data: await response.json().catch(() => null) as any, requestMs, backgroundMs: performance.now() - bgStart };
    };
    t.gemini.replies = [INK];
    const create = await timed("/lost-found/posts", "POST", { ...foundBody(photo) });
    expect(create.status).toBe(201);
    const photoId = (t.db.raw.prepare("SELECT id FROM lf_photos").get() as { id: number }).id;
    expect(photoOf(create.data.post.id)).toMatchObject({ read_state: "done", nudge: "shown" });
    const replace = await timed(`/lost-found/photos/${photoId}/replace`, "POST", { image: dataUrl(testJpeg(5)) });
    expect(replace.status).toBe(201);
    // A tick with reads due.
    const second = await t.call("/lost-found/posts", "POST", bo, foundBody(photo));
    t.db.raw.prepare("UPDATE lf_photos SET read_state = 'pending', next_attempt_at = datetime('now', '-1 minute') WHERE post_id = ?").run(second.data.post.id);
    t.db.raw.prepare("DELETE FROM lf_extractions WHERE post_id = ?").run(second.data.post.id);
    nextMinute();
    const tickStart = performance.now();
    await runLostFoundTick(t.env);
    const tickMs = performance.now() - tickStart;
    // A typical phone photo after the browser's resize (1280 px, ~350 KB).
    const typicalBytes = Uint8Array.from(big.subarray(0, 350_000));
    typicalBytes.set([0xff, 0xd9], typicalBytes.length - 2);
    const typical = await timed("/lost-found/posts", "POST", { ...foundBody(dataUrl(typicalBytes)) });
    expect(typical.status).toBe(201);
    const timings = {
      createTypicalPhotoMs: Math.round(typical.requestMs),
      createWithPhotoMs: Math.round(create.requestMs), readInWaitUntilMs: Math.round(create.backgroundMs),
      replacePhotoMs: Math.round(replace.requestMs), readAfterReplaceMs: Math.round(replace.backgroundMs), cronTickMs: Math.round(tickMs),
    };
    console.log("lost & found step timings (local wall clock, AI and storage mocked): " + JSON.stringify(timings));
    // Generous bounds: these are wall-clock numbers on a test machine, not Workers CPU. They catch an image
    // decode/encode sneaking back in (photon took ~80 ms for a 960x720 photo here).
    for (const value of Object.values(timings)) expect(value).toBeLessThan(250);
  });
});
