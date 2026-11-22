// D1-backed implementation of the small KV surface (`KVLike`/`KVListLike`) that roster.ts and
// ratelimit.ts depend on. The sign-in counters (lockouts, rate counters, WebAuthn challenges, emailed codes) live
// here when RATELIMIT_BACKEND = "d1" (the deployed setting; see limitsInD1 in index.ts): KV allows 1,000 writes a
// day on the free plan, D1 100,000 rows. It also stands in for a missing KV binding (the member roster included).
//
// Storage: one `kv_store` table, namespaced by `ns` ("roster" | "ratelimit"), with an optional
// `expires_at` (epoch ms) replicating KV's expirationTtl. Expiry is lazy (filtered on read), and the 15-minute cron
// clears expired rows nobody read again (purgeExpired), so the table stays small.

import type { KVListLike } from "./roster.js";

type Row = { value: string; expires_at: number | null };

export class D1KV implements KVListLike {
  constructor(private db: D1Database, private ns: string) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value, expires_at FROM kv_store WHERE ns = ?1 AND key = ?2")
      .bind(this.ns, key)
      .first<Row>();
    if (!row) return null;
    if (row.expires_at != null && row.expires_at <= Date.now()) {
      await this.delete(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    await this.db
      .prepare(
        "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      )
      .bind(this.ns, key, value, expiresAt)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM kv_store WHERE ns = ?1 AND key = ?2").bind(this.ns, key).run();
  }

  async list(
    opts?: { prefix?: string; cursor?: string; limit?: number },
  ): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    // Escape LIKE metacharacters in the prefix so e.g. "m_" matches literally, then anchor with "%".
    const prefix = opts?.prefix ?? "";
    const pattern = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const limit = typeof opts?.limit === "number" && Number.isInteger(opts.limit) && opts.limit > 0
      ? Math.min(opts.limit, 1000)
      : 1000;
    const cursor = typeof opts?.cursor === "string" && opts.cursor.length > 0 ? opts.cursor : null;
    const sql = cursor
      ? "SELECT key FROM kv_store WHERE ns = ?1 AND key LIKE ?2 ESCAPE '\\' AND key > ?3 " +
        "AND (expires_at IS NULL OR expires_at > ?4) ORDER BY key LIMIT ?5"
      : "SELECT key FROM kv_store WHERE ns = ?1 AND key LIKE ?2 ESCAPE '\\' " +
        "AND (expires_at IS NULL OR expires_at > ?3) ORDER BY key LIMIT ?4";
    const stmt = cursor
      ? this.db.prepare(sql).bind(this.ns, pattern, cursor, Date.now(), limit + 1)
      : this.db.prepare(sql).bind(this.ns, pattern, Date.now(), limit + 1);
    const res = await stmt.all<{ key: string }>();
    const all = res.results ?? [];
    const hasMore = all.length > limit;
    const slice = hasMore ? all.slice(0, limit) : all;
    return {
      keys: slice.map((r) => ({ name: r.key })),
      list_complete: !hasMore,
      ...(hasMore && slice.length > 0 ? { cursor: slice[slice.length - 1]!.key } : {}),
    };
  }
}

/** Delete a namespace's expired rows (the 15-minute cron). Returns how many went. */
export async function purgeExpired(db: D1Database, ns: string, now = Date.now()): Promise<number> {
  const result = await db
    .prepare("DELETE FROM kv_store WHERE ns = ?1 AND expires_at IS NOT NULL AND expires_at <= ?2")
    .bind(ns, now)
    .run();
  return Number(result.meta?.changes) || 0;
}

export const ROSTER_RECENT_NS = "roster_recent";
const RECENT_TTL_MS = 180_000; // 3x Cloudflare Workers KV's 60s eventual-consistency window
const POINT_READ_LIMIT = 2;

type OverlayEntry = { op: "put"; value: string } | { op: "del" };

/**
 * Strongly-consistent read-your-writes / read-your-deletes overlay for a Workers KV namespace,
 * backed by D1's `kv_store` table.
 *
 * Workers KV caches `get()` values at the edge for 60s and propagates `put()`/`delete()`
 * eventually. Removing a member and immediately re-adding them (or signing in with a brand-new
 * temporary PIN) can otherwise hit the stale cached record and fail with `member_exists` or 401.
 *
 * Every `put()`/`delete()` mirrors a 3-minute row in D1; the first `POINT_READ_LIMIT` (2) distinct
 * `get()` calls use indexed D1 point-reads (avoiding full-namespace scans on single-member routes
 * like `/me` and `/login`), and the 3rd distinct `get()` or any `list()` promotes to the single-query
 * overlay so batch handlers (`sheet-import/apply`, `listMembers`) stay well within D1's 50-query free-plan budget.
 */
export class ConsistentKV implements KVListLike {
  private overlay: Map<string, OverlayEntry> | null = null;
  private loading: Promise<Map<string, OverlayEntry>> | null = null;
  private pointCache = new Map<string, OverlayEntry | null>();
  private pointReads = 0;
  private listed = new Map<string, Set<string>>();

  constructor(
    private kv: KVListLike,
    private db: D1Database,
    private ns: string = ROSTER_RECENT_NS,
    private ttlMs: number = RECENT_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  private parseEntry(raw: string): OverlayEntry | null {
    try {
      const parsed = JSON.parse(raw) as OverlayEntry;
      if (parsed && (parsed.op === "del" || (parsed.op === "put" && typeof parsed.value === "string"))) {
        return parsed;
      }
    } catch { /* ignore malformed overlay row */ }
    return null;
  }

  private async loadOverlay(): Promise<Map<string, OverlayEntry>> {
    if (this.overlay) return this.overlay;
    if (!this.loading) {
      this.loading = (async () => {
        const map = new Map<string, OverlayEntry>();
        try {
          const res = await this.db
            .prepare("SELECT key, value FROM kv_store WHERE ns = ?1 AND (expires_at IS NULL OR expires_at > ?2)")
            .bind(this.ns, this.now())
            .all<{ key: string; value: string }>();
          for (const row of res.results ?? []) {
            const parsed = this.parseEntry(row.value);
            if (parsed) map.set(row.key, parsed);
          }
        } catch {
          /* D1 unavailable or unit-test mock without kv_store — fall through to KV directly */
        }
        for (const [k, v] of this.pointCache.entries()) {
          if (v && !map.has(k)) map.set(k, v);
        }
        this.overlay = map;
        return map;
      })();
    }
    return this.loading;
  }

  private async record(key: string, entry: OverlayEntry, expiresAt: number): Promise<void> {
    this.pointCache.set(key, entry);
    if (this.loading && !this.overlay) await this.loading;
    if (this.overlay) this.overlay.set(key, entry);
    try {
      await this.db
        .prepare(
          "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?1, ?2, ?3, ?4) " +
            "ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        )
        .bind(this.ns, key, JSON.stringify(entry), expiresAt)
        .run();
    } catch {
      /* best-effort overlay when a test mock lacks kv_store */
    }
  }

  private async fromOverlay(map: Map<string, OverlayEntry>, key: string): Promise<string | null> {
    const hit = map.get(key);
    if (hit) return hit.op === "del" ? null : hit.value;
    return this.kv.get(key);
  }

  async get(key: string): Promise<string | null> {
    if (this.loading && !this.overlay) await this.loading;
    if (this.overlay) return this.fromOverlay(this.overlay, key);
    if (this.pointCache.has(key)) {
      const hit = this.pointCache.get(key);
      if (hit) return hit.op === "del" ? null : hit.value;
      return this.kv.get(key);
    }
    if (this.pointReads >= POINT_READ_LIMIT) {
      return this.fromOverlay(await this.loadOverlay(), key);
    }
    this.pointReads += 1;
    let entry: OverlayEntry | null = null;
    try {
      const row = await this.db
        .prepare(
          "SELECT value FROM kv_store WHERE ns = ?1 AND key = ?2 AND (expires_at IS NULL OR expires_at > ?3)",
        )
        .bind(this.ns, key, this.now())
        .first<{ value: string }>();
      if (row) entry = this.parseEntry(row.value);
    } catch {
      /* D1 unavailable or unit-test mock without kv_store — fall through to KV directly */
    }
    const postAwaitOverlay = this.overlay as Map<string, OverlayEntry> | null;
    if (postAwaitOverlay) return this.fromOverlay(postAwaitOverlay, key);
    if (this.pointCache.has(key)) {
      const hit = this.pointCache.get(key);
      if (hit) return hit.op === "del" ? null : hit.value;
      return this.kv.get(key);
    }
    this.pointCache.set(key, entry);
    if (entry) return entry.op === "del" ? null : entry.value;
    return this.kv.get(key);
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(key, value, opts);
    const now = this.now();
    const cap = opts?.expirationTtl ? Math.min(this.ttlMs, opts.expirationTtl * 1000) : this.ttlMs;
    await this.record(key, { op: "put", value }, now + cap);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
    await this.record(key, { op: "del" }, this.now() + this.ttlMs);
  }

  async list(
    opts?: { prefix?: string; cursor?: string; limit?: number },
  ): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    const map = await this.loadOverlay();
    const prefix = opts?.prefix ?? "";
    const wrapped = typeof opts?.cursor === "string" ? /^ckv:([0-9a-f-]+):(.*)$/s.exec(opts.cursor) : null;
    const chainId = wrapped ? wrapped[1]! : opts?.cursor ? `legacy:${prefix}` : crypto.randomUUID();
    const innerCursor = wrapped ? wrapped[2] || undefined : opts?.cursor;
    let seen = this.listed.get(chainId);
    if (!seen) {
      seen = new Set();
      this.listed.set(chainId, seen);
    }
    const innerOpts = opts
      ? {
          ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(innerCursor ? { cursor: innerCursor } : {}),
        }
      : undefined;
    const page = await this.kv.list(innerOpts);
    const keys: { name: string }[] = [];
    for (const k of page.keys) {
      const hit = map.get(k.name);
      if (hit?.op === "del") continue;
      if (seen.has(k.name)) continue;
      seen.add(k.name);
      keys.push(k);
    }
    if (page.list_complete) {
      for (const [k, entry] of map.entries()) {
        if (entry.op === "put" && k.startsWith(prefix) && !seen.has(k)) {
          seen.add(k);
          keys.push({ name: k });
        }
      }
      this.listed.delete(chainId);
      return { keys, list_complete: true };
    }
    return { keys, list_complete: false, cursor: `ckv:${chainId}:${page.cursor ?? ""}` };
  }
}
