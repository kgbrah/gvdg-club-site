// Throw videos filmed by a cardmate. Pure checks only. Bytes live in R2, rows in D1.
// These clips are round media. Do not read them from handicap or ratings.

export const MAX_CLIP_BYTES = 80_000_000;
export const MAX_CLIPS_PER_ROUND = 24;
export const MAX_HIGHLIGHTS_PER_ROUND = 8;

export type ClipMoment = "ace" | "birdie" | "manual";

export interface ClipCard {
  status: string;
  recoveryRoundId?: string;
  cardId?: string;
  actorIndex?: number;
  holes: { hole: number }[];
  cardmates: { index: number; name: string }[];
}

export interface SniffedVideo {
  contentType: "video/webm" | "video/mp4";
  ext: "webm" | "mp4";
}

export function byteRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null | "invalid" {
  if (header == null || header.trim() === "") return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || size <= 0) return "invalid";
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return "invalid";
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(size, suffix);
    return { offset: size - length, length };
  }
  const offset = Number(startRaw);
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) return "invalid";
  const end = endRaw === "" ? size - 1 : Number(endRaw);
  if (!Number.isInteger(end) || end < offset) return "invalid";
  const last = Math.min(end, size - 1);
  return { offset, length: last - offset + 1 };
}

export function sniffVideo(bytes: Uint8Array): SniffedVideo | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { contentType: "video/webm", ext: "webm" };
  }
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return { contentType: "video/mp4", ext: "mp4" };
  }
  return null;
}

export function clipMoment(value: unknown): ClipMoment {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "ace" || raw === "birdie" || raw === "manual") return raw;
  return "manual";
}

export function clipTarget(
  card: ClipCard | null,
  hole: number,
  playerIndex: number,
  playerName: string,
): { ok: true; name: string } | { ok: false; error: string } {
  if (!card || (card.status !== "live" && card.status !== "final")) return { ok: false, error: "round_not_live" };
  if (!Number.isInteger(hole) || hole < 1 || hole > 36) return { ok: false, error: "invalid_hole" };
  if (!card.holes.some((row) => row.hole === hole)) return { ok: false, error: "invalid_hole" };
  const mate = card.cardmates.find((row) => row.index === playerIndex);
  if (!mate || !mate.name.trim()) return { ok: false, error: "not_on_card" };
  const want = playerName.trim().toLowerCase();
  if (want && want !== mate.name.trim().toLowerCase()) return { ok: false, error: "player_mismatch" };
  return { ok: true, name: mate.name.trim().slice(0, 80) };
}

export function cardFromMine(status: number, body: unknown): ClipCard | null {
  if (status !== 200 || !body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const holes = Array.isArray(row.holes)
    ? row.holes.flatMap((hole) => {
      const n = hole && typeof hole === "object" ? Number((hole as { hole?: unknown }).hole) : NaN;
      return Number.isInteger(n) ? [{ hole: n }] : [];
    })
    : [];
  const cardmates = Array.isArray(row.cardmates)
    ? row.cardmates.flatMap((mate) => {
      if (!mate || typeof mate !== "object") return [];
      const item = mate as { index?: unknown; name?: unknown };
      const index = Number(item.index);
      const name = String(item.name ?? "").trim();
      return Number.isInteger(index) && name ? [{ index, name }] : [];
    })
    : [];
  return {
    status: String(row.status ?? ""), holes, cardmates,
    ...(typeof row.recoveryRoundId === "string" && typeof row.cardId === "string" && Number.isInteger(row.playerIndex)
      ? { recoveryRoundId: row.recoveryRoundId, cardId: row.cardId, actorIndex: Number(row.playerIndex) }
      : {}),
  };
}

export function throwClipKey(scope: string, scopeKey: string, ext: string, uuid: string): string {
  const safeScope = scope === "event" ? "event" : "round";
  const safeKey = scopeKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  const safeId = uuid.replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  return `throw-clips/${safeScope}/${safeKey}/${safeId}.${ext}`;
}
