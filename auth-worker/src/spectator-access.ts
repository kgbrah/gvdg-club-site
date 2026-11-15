import { decodeJwt } from "jose";
import type { D1Like } from "./db-types.js";

export type RoundVisibility = "card" | "link" | "public";
type RoundSharing = { visibility: RoundVisibility; link_hash: string | null; include_marked: number };
export const SCORER_SOCKET = "gvdg-score-v1";
export const SPECTATOR_SOCKET = "gvdg-watch-v1";

export function isRoundVisibility(value: unknown): value is RoundVisibility {
  return value === "card" || value === "link" || value === "public";
}

export async function readRoundSharing(db: D1Like, code: string) {
  const row = await db.prepare("SELECT visibility, link_hash, include_marked FROM casual_round_sharing WHERE round_code = ?")
    .bind(code).first<RoundSharing>();
  return row && isRoundVisibility(row.visibility) ? row : null;
}

export async function initializeRoundSharing(db: D1Like, code: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO casual_round_sharing (round_code, visibility) VALUES (?, 'card')")
    .bind(code).run();
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function updateRoundSharing(db: D1Like, code: string, visibility: RoundVisibility, includeMarked: boolean) {
  const link = visibility === "link"
    ? Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("")
    : null;
  const hash = link ? await digest(link) : null;
  await db.prepare(
    `INSERT INTO casual_round_sharing (round_code, visibility, link_hash, include_marked) VALUES (?, ?, ?, ?)
     ON CONFLICT(round_code) DO UPDATE SET visibility = excluded.visibility, link_hash = excluded.link_hash, include_marked = excluded.include_marked`,
  ).bind(code, visibility, hash, Number(includeMarked)).run();
  return { visibility, includeMarked, ...(link ? { watchKey: link } : {}) };
}

export function watchKey(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Watch ")) return header.slice(6);
  return new URL(request.url).searchParams.get("wl");
}

export async function resolveWatchRound(db: D1Like, key: string | null): Promise<string | null> {
  if (!key || !/^[a-f0-9]{48}$/.test(key)) return null;
  const row = await db.prepare("SELECT round_code FROM casual_round_sharing WHERE link_hash = ? AND visibility = 'link'")
    .bind(await digest(key)).first<{ round_code: string }>();
  return row?.round_code ?? null;
}

export async function roundViewerAccess(db: D1Like, code: string, key: string | null) {
  const row = await readRoundSharing(db, code);
  const visibility = row?.visibility ?? "public"; // Existing rounds retain their established access.
  const allowed = key === null
    ? visibility === "public"
    : visibility === "link" && /^[a-f0-9]{48}$/.test(key) && await digest(key) === row?.link_hash;
  return { visibility, allowed, includeMarked: row ? row.include_marked === 1 : true };
}

export async function archivedRoundActor(db: D1Like, code: string, actor: string) {
  const row = await db.prepare(
    `SELECT r.created_by AS owner,
       EXISTS (SELECT 1 FROM casual_results cr WHERE cr.casual_round_id = r.id AND cr.member_id = ?) AS on_card
       FROM casual_rounds r WHERE r.round_code = ? COLLATE NOCASE ORDER BY r.id DESC LIMIT 1`,
  ).bind(actor, code).first<{ owner: string | null; on_card: number }>();
  return { owner: row?.owner === actor, onCard: row?.owner === actor || Number(row?.on_card) === 1 };
}

export function socketRequest(request: Request) {
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
  const key = protocols.includes(SPECTATOR_SOCKET) ? protocols.find((s) => s.startsWith("w."))?.slice(2) ?? null : null;
  const proof = (protocols.includes(SCORER_SOCKET) || (protocols.includes(SPECTATOR_SOCKET) && key === null)) ? protocols.find((s) => s.startsWith("a."))?.slice(2) ?? "" : "";
  const guest = protocols.includes(SCORER_SOCKET) ? protocols.find((s) => s.startsWith("g."))?.slice(2) ?? "" : "";
  const headers = new Headers(request.headers);
  for (const name of ["X-Auth-Member", "X-Auth-Admin", "X-Auth-Expires", "X-Watch-Key", "X-Round-Code", "Sec-WebSocket-Protocol", "Authorization"]) headers.delete(name);
  if (key !== null) headers.set("X-Watch-Key", key);
  const protocol = protocols.includes(SPECTATOR_SOCKET) ? SPECTATOR_SOCKET : (protocols.includes(SCORER_SOCKET) ? SCORER_SOCKET : "");
  if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
  const identityHeaders = /^[\w.-]{20,2048}$/.test(proof) ? { Authorization: "Bearer " + proof } : undefined;
  const identityUrl = new URL("https://do/ws");
  if (/^[\w-]{1,64}$/.test(guest)) identityUrl.searchParams.set("gt", guest);
  let expiry = null;
  try {
    const expires = identityHeaders ? decodeJwt(proof).exp : null;
    if (typeof expires === "number" && Number.isFinite(expires)) expiry = expires * 1_000;
  } catch { /* the existing auth gate rejects malformed credentials */ }
  return { headers, key, expiry, identity: new Request(identityUrl, { headers: identityHeaders }) };
}

/** Deliberately shared marks may appear on replays. Phone fixes and card votes stay on the card. */
export function spectatorSnapshot<T extends Record<string, unknown>>(snapshot: T, includeMarked = true, hideJoinCode = false) {
  return {
    ...snapshot,
    ...(hideJoinCode ? { roundCode: null } : {}),
    players: Array.isArray(snapshot.players) ? snapshot.players.map((player) => {
      const { throws: _throws, throwAt: _throwAt, scorecards: _votes, ...rest } = player;
      return includeMarked ? { ...rest, throws: _throws ?? {}, throwAt: _throwAt ?? null } : rest;
    }) : [],
    playerLocations: [],
    joinRequests: [],
    conflicts: [],
    missing: [],
  };
}

export function spectatorScorecard(raw: unknown, includeMarked: boolean): string | null {
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { hole, par, strokes, points, throws } = entry;
      return [{ hole, par, strokes, ...(typeof points === "number" ? { points } : {}), ...(includeMarked && Array.isArray(throws) ? { throws: throws.map(({ lat, lng, n }) => ({ lat, lng, n })) } : {}) }];
    }));
  } catch {
    return null;
  }
}
