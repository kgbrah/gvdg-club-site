import type { D1Like } from "./db.js";
import { REMOTE_LIMITS, type PracticeKind, type PracticeMutation, type PracticeRecord, type ThrowRecord } from "./practice-input.js";

const PAGE_SIZE = 40;
const RECEIPT_AGE_MS = 90 * 86_400_000;

interface StoredRow {
  id: string;
  kind: PracticeKind;
  revision: number;
  occurred_on: string;
  payload: string;
}

function publicRecord(row: StoredRow) {
  return { id: row.id, kind: row.kind, revision: row.revision, record: JSON.parse(row.payload) as PracticeRecord };
}

function listRecords(db: D1Like, owner: string, kind: PracticeKind, limit: number, before?: Cursor) {
  return db.prepare(
    `SELECT id, kind, revision, occurred_on, payload FROM member_practice_records
       WHERE owner = ? AND kind = ? AND payload IS NOT NULL
         AND (? IS NULL OR (occurred_on, id) < (?, ?))
       ORDER BY occurred_on DESC, id DESC LIMIT ?`,
  ).bind(owner, kind, before?.date ?? null, before?.date ?? null, before?.id ?? null, limit).all<StoredRow>();
}

export interface Cursor { date: string; id: string }

export function practiceCursor(value: string | null): Cursor | null {
  const match = /^(\d{4}-\d\d-\d\d)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(value || "");
  return match ? { date: match[1]!, id: match[2]! } : null;
}

export async function practiceHistory(db: D1Like, owner: string, kind: "throw" | "putting", before?: Cursor) {
  const result = await listRecords(db, owner, kind, PAGE_SIZE + 1, before);
  const items = result.results.slice(0, PAGE_SIZE);
  const tail = items.at(-1);
  return {
    items: items.map(publicRecord),
    next: tail && result.results.length > PAGE_SIZE ? tail.occurred_on + "/" + tail.id : null,
  };
}

interface Totals { attempts: number; makes: number; sessions: number }
interface PuttingTrend {
  meters: number; attempts: number; makes: number; lastAttempts: number; lastMakes: number;
  priorAttempts: number; priorMakes: number;
}

const STATION_VALUES = `
  FROM member_practice_records AS r, json_each(r.payload, '$.stations') AS station
  WHERE r.owner = ? AND r.kind = 'putting' AND r.payload IS NOT NULL
`;
const TOTAL_STATION = `sum(json_extract(station.value, '$.attempts')) AS attempts,
  sum(json_extract(station.value, '$.makes')) AS makes`;

async function summaries(db: D1Like, owner: string) {
  const [totals, putting, throws] = await Promise.all([
    db.prepare(`SELECT count(DISTINCT r.id) AS sessions, ${TOTAL_STATION} ${STATION_VALUES}`).bind(owner).first<Totals>(),
    db.prepare(`
      SELECT json_extract(station.value, '$.meters') AS meters,
        ${TOTAL_STATION},
        sum(CASE WHEN date(r.occurred_on) > date('now', '-30 days') THEN json_extract(station.value, '$.attempts') ELSE 0 END) AS lastAttempts,
        sum(CASE WHEN date(r.occurred_on) > date('now', '-30 days') THEN json_extract(station.value, '$.makes') ELSE 0 END) AS lastMakes,
        sum(CASE WHEN date(r.occurred_on) > date('now', '-60 days') AND date(r.occurred_on) <= date('now', '-30 days') THEN json_extract(station.value, '$.attempts') ELSE 0 END) AS priorAttempts,
        sum(CASE WHEN date(r.occurred_on) > date('now', '-60 days') AND date(r.occurred_on) <= date('now', '-30 days') THEN json_extract(station.value, '$.makes') ELSE 0 END) AS priorMakes
        ${STATION_VALUES}
        GROUP BY meters ORDER BY attempts DESC, meters ASC LIMIT 50
      `).bind(owner).all<PuttingTrend>(),
    db.prepare(`
      SELECT json_extract(payload, '$.discId') AS discId, json_extract(payload, '$.shotType') AS shotType,
        count(*) AS throws, round(avg(json_extract(payload, '$.meters')), 2) AS averageMeters,
        max(json_extract(payload, '$.meters')) AS farthestMeters
        FROM member_practice_records WHERE owner = ? AND kind = 'throw' AND payload IS NOT NULL
        GROUP BY discId, shotType ORDER BY throws DESC, discId, shotType LIMIT 50
      `).bind(owner).all(),
  ]);
  return {
    puttingTotals: { attempts: totals?.attempts ?? 0, makes: totals?.makes ?? 0, sessions: totals?.sessions ?? 0 },
    puttingTrends: putting.results,
    throwGroups: throws.results,
  };
}

export async function readPractice(db: D1Like, owner: string) {
  const [discs, throws, putting, stats] = await Promise.all([
    listRecords(db, owner, "disc", REMOTE_LIMITS.disc),
    practiceHistory(db, owner, "throw"),
    practiceHistory(db, owner, "putting"),
    summaries(db, owner),
  ]);
  return { owner, discs: discs.results.map(publicRecord), throws, putting, ...stats };
}

export async function exportPractice(db: D1Like, owner: string) {
  const [discs, throws, putting] = await Promise.all([
    listRecords(db, owner, "disc", REMOTE_LIMITS.disc),
    listRecords(db, owner, "throw", REMOTE_LIMITS.throw),
    listRecords(db, owner, "putting", REMOTE_LIMITS.putting),
  ]);
  return {
    version: 1, exportedAt: new Date().toISOString(),
    discs: discs.results.map(publicRecord), throws: throws.results.map(publicRecord), putting: putting.results.map(publicRecord),
  };
}

async function fingerprint(mutation: PracticeMutation) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(mutation)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const HAS_CLAIM = `EXISTS (
  SELECT 1 FROM member_practice_operations WHERE owner = ? AND op_id = ? AND claim = ?
)`;
const HAS_DISC = `(? IS NULL OR EXISTS (
  SELECT 1 FROM member_practice_records WHERE owner = ? AND id = ? AND kind = 'disc' AND payload IS NOT NULL
))`;

/** A unique receipt, its precondition, and its result are recorded in the same D1 transaction. */
export async function writePractice(db: D1Like, owner: string, mutation: PracticeMutation, now = Date.now()) {
  if (!db.batch) throw new Error("practice_batch_required");
  const { opId, id, kind, expectedRevision, record, action } = mutation;
  const claim = crypto.randomUUID();
  const hash = await fingerprint(mutation);
  const limit = REMOTE_LIMITS[kind];
  const disc = action === "save" && kind === "throw" ? (record as ThrowRecord).discId : null;
  const deleteDisc = Number(action === "delete" && kind === "disc");
  const date = record && "date" in record ? record.date : new Date(now).toISOString().slice(0, 10);
  const payload = record ? JSON.stringify(record) : null;
  const wipe = db.prepare("DELETE FROM member_practice_operations WHERE owner = ? AND created_at < ?")
    .bind(owner, now - RECEIPT_AGE_MS);
  const trim = db.prepare(
    `DELETE FROM member_practice_operations WHERE owner = ? AND (created_at, op_id) < (
       SELECT created_at, op_id FROM member_practice_operations WHERE owner = ?
       ORDER BY created_at DESC, op_id DESC LIMIT 1 OFFSET 4998
     )`,
  ).bind(owner, owner);
  const claimRow = db.prepare(
    `INSERT INTO member_practice_operations(owner, op_id, fingerprint, claim, result, created_at) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(owner, op_id) DO NOTHING`,
  ).bind(owner, opId, hash, claim, now);
  const change = expectedRevision === 0 ? db.prepare(
    `INSERT INTO member_practice_records(owner, id, kind, revision, occurred_on, payload, last_op, updated_at)
      SELECT ?, ?, ?, 1, ?, ?, ?, ? WHERE ${HAS_CLAIM} AND ${HAS_DISC}
        AND (SELECT count(*) FROM member_practice_records WHERE owner = ? AND kind = ? AND payload IS NOT NULL) < ?
      ON CONFLICT(owner, id) DO NOTHING`,
  ).bind(owner, id, kind, date, payload, opId, now, owner, opId, claim, disc, owner, disc, owner, kind, limit)
    : db.prepare(
      `UPDATE member_practice_records SET revision = revision + 1,
         occurred_on = CASE WHEN ? IS NULL THEN occurred_on ELSE ? END, payload = ?, last_op = ?, updated_at = ?
         WHERE owner = ? AND id = ? AND kind = ? AND revision = ? AND payload IS NOT NULL
           AND ${HAS_CLAIM} AND ${HAS_DISC}
           AND (? = 0 OR (json_extract(payload, '$.archived') = 1 AND NOT EXISTS (
             SELECT 1 FROM member_practice_records AS used WHERE used.owner = ? AND used.kind = 'throw'
               AND used.payload IS NOT NULL AND json_extract(used.payload, '$.discId') = ?
           )))`,
    ).bind(payload, date, payload, opId, now, owner, id, kind, expectedRevision, owner, opId, claim, disc, owner, disc, deleteDisc, owner, id);
  const complete = db.prepare(
    `UPDATE member_practice_operations SET result = CASE
      WHEN EXISTS (SELECT 1 FROM member_practice_records WHERE owner = ? AND id = ? AND kind = ? AND last_op = ? AND revision = ?) THEN 'saved'
      WHEN NOT ${HAS_DISC} THEN 'disc_unavailable'
      WHEN ? = 1 AND EXISTS (
        SELECT 1 FROM member_practice_records cur
        WHERE cur.owner = ? AND cur.id = ? AND cur.kind = 'disc' AND cur.revision = ? AND cur.payload IS NOT NULL
          AND (
            COALESCE(json_extract(cur.payload, '$.archived'), 0) != 1
            OR EXISTS (
              SELECT 1 FROM member_practice_records AS used
              WHERE used.owner = ? AND used.kind = 'throw' AND used.payload IS NOT NULL AND json_extract(used.payload, '$.discId') = ?
            )
          )
      ) THEN 'disc_in_use'
      WHEN ? = 0 AND (SELECT count(*) FROM member_practice_records WHERE owner = ? AND kind = ? AND payload IS NOT NULL) >= ? THEN 'record_limit'
      ELSE 'record_changed' END
      WHERE owner = ? AND op_id = ? AND claim = ?`,
  ).bind(owner, id, kind, opId, expectedRevision + 1, disc, owner, disc, deleteDisc, owner, id, expectedRevision, owner, id, expectedRevision, owner, kind, limit, owner, opId, claim);
  const check = db.prepare("SELECT fingerprint, result FROM member_practice_operations WHERE owner = ? AND op_id = ?").bind(owner, opId);
  const results = await db.batch([wipe, trim, claimRow, change, complete, check]);
  const receipt = results.at(-1)?.results[0];
  if (!receipt?.result) throw new Error("practice_receipt_missing");
  if (receipt.fingerprint !== hash) return { ok: false, error: "operation_conflict" } as const;
  if (receipt.result !== "saved") return { ok: false, error: String(receipt.result) } as const;
  return { ok: true, id, revision: expectedRevision + 1 } as const;
}
