import type { D1Like } from "./db-types.js";
import { parseExportCursor, readPersonalPlayPage, type Round } from "./play-history.js";
import {
  ARCHIVE_PAGE_SIZE, archiveClipId, archiveFingerprint, archiveRoundId, canonicalArchiveJson, type ArchiveClock, type ArchiveEntry,
} from "./member-archive.js";
import type { PracticeKind } from "./practice-input.js";

const PRIVATE_PAGE_SIZE = 16;
const ID_CURSOR = /^[1-9]\d{0,15}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CLOCKS = {
  competitive: "SELECT id, created_at AS recorded FROM results",
  casual: `SELECT res.id, res.created_at AS recorded, r.started_at, r.finalized_at
    FROM casual_results res JOIN casual_rounds r ON r.id = res.casual_round_id`,
  udisc: "SELECT id, imported_at AS recorded, source_played_at, source_finished_at FROM udisc_history",
};
type ClockRow = { id: number; recorded: string | null; started_at?: string | null; finalized_at?: string | null; source_played_at?: string | null; source_finished_at?: string | null };
type PracticeRow = { id: string; kind: PracticeKind; revision: number; occurred_on: string; updated_at: number; payload: string };
type RestoredRow = { id: number; payload: string; imported_at: string };

export type ArchiveCursor = { section: "play" | "practice" | "restored"; after: string };

function safeId(value: string) { return ID_CURSOR.test(value) && Number.isSafeInteger(Number(value)); }

export function archiveCursor(value: string | null): ArchiveCursor | null {
  if (!value) return { section: "play", after: "0:0" };
  const colon = value.indexOf(":");
  if (colon < 0) return null;
  const section = value.slice(0, colon);
  const after = value.slice(colon + 1);
  if (section === "play" && after && parseExportCursor(after)) return { section, after };
  if (section === "practice" && (after === "" || UUID.test(after))) return { section, after };
  if (section === "restored" && (after === "" || safeId(after))) return { section, after };
  return null;
}

function storedTime(value: unknown) { return typeof value === "string" && value.length ? value : null; }

async function playClocks(db: D1Like, owner: string, rounds: Round[]) {
  const clocks = new Map<string, ArchiveClock>();
  for (const source of ["competitive", "casual", "udisc"] as const) {
    const ids = rounds.filter((round) => round.source === source).map((round) => round.resultId);
    if (!ids.length) continue;
    const table = source === "casual" ? "res." : "";
    const holes = ids.map(() => "?").join(", ");
    const result = await db.prepare(CLOCKS[source] + ` WHERE ${table}member_id = ? AND ${table}id IN (${holes})`)
      .bind(owner, ...ids).all<ClockRow>();
    if (!result.success) throw new Error("archive_read_failed");
    for (const row of result.results) {
      clocks.set(source + ":" + row.id, {
        startedAt: storedTime(row.started_at),
        finalizedAt: storedTime(row.finalized_at),
        resultRecordedAt: storedTime(row.recorded),
        sourcePlayedAt: storedTime(row.source_played_at),
        ...(row.source_finished_at ? { sourceFinishedAt: row.source_finished_at } : {}),
      });
    }
  }
  return clocks;
}

function libraryEntry(row: RestoredRow) {
  return { id: row.id, importedAt: row.imported_at, entry: JSON.parse(row.payload) as ArchiveEntry };
}

async function restoredPage(db: D1Like, owner: string, after: number) {
  const response = await db.prepare(
    `SELECT id, payload, imported_at FROM member_archive_records WHERE owner = ? AND id > ?
       ORDER BY id LIMIT ?`,
  ).bind(owner, after, PRIVATE_PAGE_SIZE + 1).all<RestoredRow>();
  if (!response.success) throw new Error("archive_read_failed");
  const rows = response.results.slice(0, PRIVATE_PAGE_SIZE);
  return { rows: rows.map(libraryEntry), next: response.results.length > rows.length ? String(rows.at(-1)!.id) : null };
}

export async function readArchiveLibrary(db: D1Like, owner: string, rawCursor: string | null) {
  if (rawCursor && !safeId(rawCursor)) return null;
  return restoredPage(db, owner, rawCursor ? Number(rawCursor) : 0);
}

export async function exportArchivePage(db: D1Like, owner: string, cursor: ArchiveCursor) {
  if (cursor.section === "play") {
    const page = await readPersonalPlayPage(db, owner, parseExportCursor(cursor.after)!, ARCHIVE_PAGE_SIZE, true);
    const clocks = await playClocks(db, owner, page.rounds);
    const entries: ArchiveEntry[] = page.rounds.map((round) => ({
      owner, kind: "round", sourceId: archiveRoundId(round), data: {
        round,
        clock: clocks.get(round.source + ":" + round.resultId) ?? {
          startedAt: round.offlineSnapshot?.startedAt ?? null,
          finalizedAt: round.offlineSnapshot?.finishedAt ?? null,
          resultRecordedAt: round.importedAt,
          sourcePlayedAt: null,
        },
      },
    }));
    entries.push(...page.clips.map((clip): ArchiveEntry => ({ owner, kind: "clip", sourceId: archiveClipId(clip), data: clip })));
    return { entries, next: page.next ? "play:" + page.next : "practice:" };
  }
  if (cursor.section === "practice") {
    const response = await db.prepare(
      `SELECT id, kind, revision, occurred_on, updated_at, payload FROM member_practice_records
       WHERE owner = ? AND payload IS NOT NULL AND id > ? ORDER BY id LIMIT ?`,
    ).bind(owner, cursor.after, ARCHIVE_PAGE_SIZE + 1).all<PracticeRow>();
    if (!response.success) throw new Error("archive_read_failed");
    const rows = response.results.slice(0, ARCHIVE_PAGE_SIZE);
    return {
      entries: rows.map((row): ArchiveEntry => ({ owner, kind: row.kind, sourceId: row.id, data: {
        id: row.id, revision: row.revision, occurredOn: row.occurred_on, updatedAt: row.updated_at, record: JSON.parse(row.payload),
      } })),
      next: response.results.length > rows.length ? "practice:" + rows.at(-1)!.id : "restored:",
    };
  }
  const previous = await restoredPage(db, owner, Number(cursor.after) || 0);
  return { entries: previous.rows.map(({ entry }) => entry), next: previous.next ? "restored:" + previous.next : null };
}

export async function restoreArchiveEntries(db: D1Like, owner: string, entries: ArchiveEntry[], importedAt: string) {
  if (!db.batch) throw new Error("archive_batch_required");
  const statements = await Promise.all(entries.map(async (entry) => {
    const payload = canonicalArchiveJson(entry);
    const hash = await archiveFingerprint(payload);
    return db.prepare(
      `INSERT INTO member_archive_records(owner, kind, source_id, fingerprint, payload, imported_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, kind, source_id, fingerprint) DO NOTHING`,
    ).bind(owner, entry.kind, entry.sourceId, hash, payload, importedAt);
  }));
  let results;
  try { results = await db.batch(statements); }
  catch (error) {
    if (String(error).includes("member_archive_limit")) return { ok: false, error: "archive_limit" } as const;
    throw error;
  }
  if (results.some((result) => !result.success)) throw new Error("archive_restore_failed");
  const saved = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  return { ok: true, saved, duplicates: entries.length - saved } as const;
}

export async function removeArchiveEntry(db: D1Like, owner: string, id: string) {
  if (!safeId(id)) return false;
  const result = await db.prepare("DELETE FROM member_archive_records WHERE owner = ? AND id = ?").bind(owner, Number(id)).run();
  if (!result.success) throw new Error("archive_delete_failed");
  return result.meta?.changes === 1;
}
