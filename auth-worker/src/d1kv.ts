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
    const res = await this.db
      .prepare(
        "SELECT key FROM kv_store WHERE ns = ?1 AND key LIKE ?2 ESCAPE '\\' " +
          "AND (expires_at IS NULL OR expires_at > ?3) ORDER BY key",
      )
      .bind(this.ns, pattern, Date.now())
      .all<{ key: string }>();
    return { keys: (res.results ?? []).map((r) => ({ name: r.key })), list_complete: true };
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

type OverlayEntry = { op: "put"; value: string } | { op: "del" };

/**
 * Strongly-consistent read-your-writes / read-your-deletes overlay for a Workers KV namespace,
 * backed by D1's `kv_store` table.
 *
 * Workers KV caches `get()` values at the edge for 60s and propagates `put()`/`delete()`
 * eventually. Removing a member and immediately re-adding them (or signing in with a brand-new
 * temporary PIN) can otherwise hit the stale cached record and fail with `member_exists` or 401.
 *
 * Every `put()`/`delete()` mirrors a 3-minute row in D1; each request loads unexpired rows in
 * ONE D1 query on first read so `listMembers()` stays well within D1's per-request query budget.
 */
export class ConsistentKV implements KVListLike {
  private overlay: Map<string, OverlayEntry> | null = null;
  private loading: Promise<Map<string, OverlayEntry>> | null = null;
  private listed = new Map<string, Set<string>>();

  constructor(
    private kv: KVListLike,
    private db: D1Database,
    private ns: string = ROSTER_RECENT_NS,
    private ttlMs: number = RECENT_TTL_MS,
    private now: () => number = Date.now,
  ) {}

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
            try {
              const parsed = JSON.parse(row.value) as OverlayEntry;
              if (parsed && (parsed.op === "del" || (parsed.op === "put" && typeof parsed.value === "string"))) {
                map.set(row.key, parsed);
              }
            } catch { /* ignore malformed overlay row */ }
          }
        } catch {
          /* D1 unavailable or unit-test mock without kv_store — fall through to KV directly */
        }
        this.overlay = map;
        return map;
      })();
    }
    return this.loading;
  }

  private async record(key: string, entry: OverlayEntry, expiresAt: number): Promise<void> {
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

  async get(key: string): Promise<string | null> {
    const map = await this.loadOverlay();
    const hit = map.get(key);
    if (hit) return hit.op === "del" ? null : hit.value;
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
    if (!opts?.cursor) this.listed.set(prefix, new Set());
    let seen = this.listed.get(prefix);
    if (!seen) {
      seen = new Set();
      this.listed.set(prefix, seen);
    }
    const page = await this.kv.list(opts);
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
      this.listed.delete(prefix);
    }
    return { ...page, keys };
  }
}
