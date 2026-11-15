import { parseOfflineRound } from "../../src/shared/offline-round.js";
import { parseShotRows, shotPoint, validLedgerRevision } from "../../src/shared/shot-ledger.js";
import { SHOT_STAT_DEFINITIONS } from "../../src/shared/shot-stats-model.js";
import { emptyPlayTotals } from "./play-stats.js";
import { parsePracticeMutation, type PracticeKind } from "./practice-input.js";
import type { Clip, Round } from "./play-history.js";

export const ARCHIVE_VERSION = "gvdg-personal-archive-1";
export const MAX_ARCHIVE_ENTRY_BYTES = 700_000;
export const MAX_ARCHIVE_PART_BYTES = 750_000;
export const ARCHIVE_PAGE_SIZE = 16;
export const ARCHIVE_KINDS = ["round", "disc", "throw", "putting", "clip"] as const;
export type ArchiveKind = typeof ARCHIVE_KINDS[number];
type Row = Record<string, unknown>;

export const ARCHIVE_MANIFEST = {
  ...SHOT_STAT_DEFINITIONS,
  scope: "Saved club and casual results owned by this account, saved offline rounds, UDisc imports, synced practice and bag records, references to clips uploaded by this account, and privately restored copies.",
  credentials: "Session, PIN, passkey and device pairing data are excluded. Active cards and records saved only on a device are outside this server archive.",
  media: "Clip records describe uploaded videos and identify their existing media path. Video bytes, storage keys and signed URLs are excluded. Restoring a reference cannot restore a deleted video or change its access rules.",
  time: "All known timestamps and offsets are preserved as stored. An older UDisc wall time may have no original offset. Practice dates are calendar dates.",
  measurements: "Practice uses the original distance and unit alongside the stored meter conversion. Scores, shot classifications and positions are saved values. Team shots keep their original scope.",
  restore: "Restore creates private snapshots. It preserves original source IDs and revisions. Exact duplicates are skipped. Distinct versions of the same source can coexist. Restored scorecards are outside official results, ratings and leaderboards.",
  csv: "CSV is a spreadsheet view. Each data_json cell preserves the original entry. Use the JSON backup for restoration.",
};

export type ArchiveClock = {
  startedAt: string | null; finalizedAt: string | null; resultRecordedAt: string | null;
  sourcePlayedAt: string | null; sourceFinishedAt?: string | null;
};
export type ArchiveRound = { round: Round; clock: ArchiveClock };
export type ArchivePractice = { id: string; revision: number; occurredOn: string; updatedAt: number; record: unknown };
export type ArchiveEntry = { owner: string; kind: ArchiveKind; sourceId: string; data: ArchiveRound | ArchivePractice | Clip };

const KINDS: readonly string[] = ARCHIVE_KINDS;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const encoding = new TextEncoder();
const BREAKDOWN_FIELDS = Object.keys(emptyPlayTotals());

export function archiveBytes(value: string) { return encoding.encode(value).byteLength; }
export function archiveObject(value: unknown, keys?: readonly string[]): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Row;
  return !keys || Object.keys(row).every((key) => keys.includes(key)) ? row : null;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\u0000");
}
function textOrNull(value: unknown, max: number) { return value === null || text(value, max); }
function number(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is number {
  return number(value, min, max) && Number.isSafeInteger(value);
}
function numberOrNull(value: unknown, min: number, max: number) { return value === null || number(value, min, max); }
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const timestamp = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
function dateAsStored(value: unknown) {
  // The legacy UDisc parser admitted a day up to 31 in every month.
  return typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value);
}

function timestamp(value: unknown) {
  if (!text(value, 128) || !dateAsStored(value.slice(0, 10))) return false;
  // Accepted source forms include a date, an ISO/SQLite timestamp and a UDisc local clock with an optional offset.
  return /^\d{4}-\d\d-\d\d(?:[ T]+(?:\d{1,2}:\d\d(?::\d\d(?:\.\d{1,6})?)?(?:\s*[APap][Mm])?|\d{3,4})(?:\s*(?:Z|[+-]\d\d:?\d\d))?)?$/.test(value);
}
function timestampOrNull(value: unknown) { return value === null || timestamp(value); }

function coords(value: unknown, mark = false) {
  if (value === null) return !mark;
  const row = archiveObject(value, mark ? ["lat", "lng", "n"] : ["lat", "lng", "label"]);
  return !!row && number(row.lat, -90, 90) && number(row.lng, -180, 180) &&
    (mark ? integer(row.n) : row.label === undefined || text(row.label, 512));
}

export function canonicalArchiveJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalArchiveJson).join(",") + "]";
  const row = archiveObject(value);
  if (row) return "{" + Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalArchiveJson(row[key])).join(",") + "}";
  return JSON.stringify(value);
}

function sameJson(a: unknown, b: unknown) { return canonicalArchiveJson(a) === canonicalArchiveJson(b); }

function ledger(value: unknown): boolean {
  const row = archiveObject(value, ["rows", "revision", "scope", "binding", "targetId", "label", "version", "matchesResult", "geometry"]);
  if (!row || typeof row.revision !== "string" || !validLedgerRevision(row.revision) ||
    !["team", "player"].includes(String(row.scope)) || !text(row.binding, 256) || !text(row.targetId, 512) || !text(row.label, 512) ||
    !integer(row.version, 0) || typeof row.matchesResult !== "boolean") return false;
  const rows = parseShotRows(row.rows);
  if (!rows?.length || !sameJson(rows, row.rows)) return false;
  const geometry = archiveObject(row.geometry, ["tee", "target"]);
  return !!geometry && [geometry.tee, geometry.target].every((point) => point === null || !!shotPoint(point) && sameJson(shotPoint(point), point));
}

function layout(value: unknown) {
  if (value === null) return true;
  const row = archiveObject(value, ["tee", "target", "distanceFt", "overridden"]);
  return !!row && coords(row.tee) && coords(row.target) && numberOrNull(row.distanceFt, 0, 100_000) && typeof row.overridden === "boolean";
}

function roundHole(value: unknown, seen: Set<number>) {
  const row = archiveObject(value, ["hole", "par", "strokes", "points", "distanceFt", "layoutAtPlay", "marks", "marksStatus", "shotLedger"]);
  if (!row || !integer(row.hole, 1, 36) || seen.has(row.hole) ||
    !numberOrNull(row.par, 0, 99) || !numberOrNull(row.strokes, 0, 4000) || !numberOrNull(row.points, -10_000, 10_000) ||
    !numberOrNull(row.distanceFt, 0, 100_000) || !layout(row.layoutAtPlay) ||
    !Array.isArray(row.marks) || row.marks.length > 1000 || !row.marks.every((point) => coords(point, true)) ||
    !["saved", "none", "unattributed"].includes(String(row.marksStatus)) ||
    (row.shotLedger !== undefined && !ledger(row.shotLedger))) return false;
  seen.add(row.hole);
  return true;
}

const ROUND_FIELDS = ["id", "source", "resultId", "eventId", "roundCode", "importedRoundKey", "importedAt", "playedAt", "playedDate",
  "eventName", "courseId", "courseName", "layoutId", "layoutName", "group", "style", "total", "toPar", "holes", "savedBreakdown", "offlineSnapshot"];

export function archiveRoundId(round: Round) {
  if (round.source === "offline") return "offline:" + round.offlineSnapshot?.localId;
  if (round.source === "udisc" && round.importedRoundKey) return "udisc:" + round.importedRoundKey;
  return round.id;
}

function roundData(value: unknown, owner: string): ArchiveRound | null {
  const wrapper = archiveObject(value, ["round", "clock"]);
  const row = archiveObject(wrapper?.round, ROUND_FIELDS);
  const clock = archiveObject(wrapper?.clock, ["startedAt", "finalizedAt", "resultRecordedAt", "sourcePlayedAt", "sourceFinishedAt"]);
  if (!row || !clock || !["startedAt", "finalizedAt", "resultRecordedAt", "sourcePlayedAt"].every((key) => timestampOrNull(clock[key])) ||
    (clock.sourceFinishedAt !== undefined && !timestampOrNull(clock.sourceFinishedAt)) ||
    !["competitive", "casual", "udisc", "offline"].includes(String(row.source)) || !text(row.id, 512) || !integer(row.resultId) ||
    ![row.eventId, row.courseId, row.layoutId].every((value) => value === null || integer(value)) ||
    ![row.eventName, row.courseName, row.layoutName, row.roundCode, row.importedRoundKey].every((value) => textOrNull(value, 1024)) ||
    !timestampOrNull(row.playedAt) || !timestampOrNull(row.importedAt) || !(row.playedDate === null || dateAsStored(row.playedDate)) ||
    !["singles", "doubles", "unknown"].includes(String(row.group)) || !["stroke", "matchplay", "putting"].includes(String(row.style)) ||
    !numberOrNull(row.total, 0, 300_000) || !numberOrNull(row.toPar, -300_000, 300_000) ||
    !Array.isArray(row.holes) || row.holes.length > 36) return null;
  const seen = new Set<number>();
  if (!row.holes.every((hole) => roundHole(hole, seen))) return null;
  if (row.savedBreakdown !== null) {
    const breakdown = archiveObject(row.savedBreakdown, BREAKDOWN_FIELDS);
    if (!breakdown || !Object.values(breakdown).every((value) => integer(value, 0, 300_000))) return null;
  }
  if (row.source === "offline") {
    const snapshot = parseOfflineRound(row.offlineSnapshot);
    if (!snapshot || snapshot.owner.kind !== "member" || snapshot.owner.id !== owner || !sameJson(snapshot, row.offlineSnapshot) ||
      row.id !== "offline:" + snapshot.localId + ":" + row.resultId) return null;
  } else {
    if (row.offlineSnapshot !== undefined || row.id !== row.source + ":" + (row.eventId ?? row.roundCode ?? row.importedRoundKey ?? row.resultId) + ":" + row.resultId) return null;
  }
  return wrapper as ArchiveRound;
}

export function archiveClipId(clip: Clip) {
  return clip.scope === "offline" ? "offline-clip:" + (clip.clientId ?? clip.scopeKey + ":" + clip.id) : "live-clip:" + clip.id;
}

function clipData(value: unknown): Clip | null {
  const row = archiveObject(value, ["id", "scope", "scopeKey", "hole", "createdAt", "contentType", "bytes", "highlight", "moment", "mediaPath",
    "clientId", "playerIndex", "playerName"]);
  if (!row || !integer(row.id) || !integer(row.hole, 1, 36) || !text(row.scopeKey, 160) || !/^[a-zA-Z0-9_-]{1,160}$/.test(row.scopeKey) ||
    !["event", "round", "offline"].includes(String(row.scope)) || !integer(row.bytes, 0) || typeof row.highlight !== "boolean" ||
    !timestamp(row.createdAt) || !text(row.contentType, 128) || !textOrNull(row.moment, 256)) return null;
  const offline = row.scope === "offline";
  if (offline && (!text(row.clientId, 36) || !UUID.test(row.clientId) || !integer(row.playerIndex, 0, 15) || !text(row.playerName, 60))) return null;
  if (!offline && ((row.clientId !== undefined && (!text(row.clientId, 36) || !UUID.test(row.clientId))) ||
      (row.playerIndex !== undefined && !integer(row.playerIndex, 0, 4096)) ||
      (row.playerName !== undefined && !text(row.playerName, 80)))) return null;
  const path = offline ? "/offline-rounds/" + row.scopeKey + "/clips/" + row.id + "/media" :
    (row.scope === "event" ? "/events/" : "/rounds/") + row.scopeKey + "/live/clips/" + row.id + "/media";
  return row.mediaPath === path ? row as Clip : null;
}

function practiceData(value: unknown, owner: string, kind: PracticeKind): ArchivePractice | null {
  const row = archiveObject(value, ["id", "revision", "occurredOn", "updatedAt", "record"]);
  const record = archiveObject(row?.record);
  if (!row || !record || typeof row.id !== "string" || !UUID.test(row.id) || !integer(row.revision) ||
    !date(row.occurredOn) || !integer(row.updatedAt, 0) || (kind !== "disc" && record.date !== row.occurredOn)) return null;
  const { meters: _derived, ...source } = record;
  if (kind === "putting" && Array.isArray(source.stations)) source.stations = source.stations.map((value) => {
    const { meters: _conversion, ...station } = archiveObject(value) ?? {};
    return station;
  });
  const parsed = parsePracticeMutation({ owner, opId: row.id, id: row.id, action: "save", kind, expectedRevision: 0, record: source }, owner, Date.parse(row.occurredOn));
  return parsed?.record && sameJson(parsed.record, record) ? row as ArchivePractice : null;
}

export function parseArchiveEntry(value: unknown, owner: string): ArchiveEntry | null {
  const row = archiveObject(value, ["owner", "kind", "sourceId", "data"]);
  if (!row || row.owner !== owner || typeof row.kind !== "string" || !KINDS.includes(row.kind) || !text(row.sourceId, 512)) return null;
  const kind = row.kind as ArchiveKind;
  if (kind === "round") {
    const data = roundData(row.data, owner);
    return data && archiveRoundId(data.round) === row.sourceId ? { owner, kind, sourceId: row.sourceId, data } : null;
  }
  if (kind === "clip") {
    const data = clipData(row.data);
    return data && archiveClipId(data) === row.sourceId ? { owner, kind, sourceId: row.sourceId, data } : null;
  }
  const data = practiceData(row.data, owner, kind);
  return data && data.id === row.sourceId ? { owner, kind, sourceId: row.sourceId, data } : null;
}

export async function archiveFingerprint(payload: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoding.encode(payload)));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}
