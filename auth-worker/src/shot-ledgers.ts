import { parseShotRows, shotHoleGeometry, shotPoint, validLedgerRevision, type ShotLedger, type ShotRecord } from "../../src/shared/shot-ledger.js";
import type { D1Like } from "./db-types.js";
import { liveRecoveryId, matchesLiveRecoveryScope } from "./live-recovery.js";
import { healthyTargets, isCardLocked, scoringState } from "./live-state.js";
import { j, type LiveMeta, type LiveState, type ResolvedHole } from "./live-types.js";
import { roundPlayStats } from "./play-stats.js";
import type { FinalLiveStanding, PlayerState } from "./scoring.js";

const text = new TextEncoder();
const RECEIPTS_PER_HOLE = 64;

type Receipt = { actorIndex: number; revision: string; digest: string };
type Cell = ShotLedger & { receipts: Receipt[] };
type ShotBook = Record<number, Cell>;
export type ShotLedgerViews = Record<number, Record<number, ShotLedger>>;
export type ArchivedShotLedger = ShotLedger & { matchesResult: boolean };

type LedgerEdit = {
  hole: number; scorerIndex: number; targetId: string; binding: string; rows: ShotRecord[];
  recovery: Record<string, unknown>; previous: string | null; revision: string;
  geometry: ShotLedger["geometry"];
};

export function hasShotLedgerEdit(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && "ledger" in body);
}

function parseEdit(body: unknown): LedgerEdit | null {
  const value = body as Record<string, unknown>;
  const draft = value.ledger as Record<string, unknown> | null;
  const recovery = value.recovery as Record<string, unknown> | null;
  if (!draft || !recovery || typeof recovery !== "object" || Array.isArray(recovery)) return null;
  const { hole, scorerIndex } = value;
  const { targetId, binding } = draft;
  const { previous, order } = recovery;
  const rows = parseShotRows(draft.rows);
  const geometryInput = draft.geometry as Record<string, unknown> | null;
  if (!geometryInput || typeof geometryInput !== "object" || Array.isArray(geometryInput)) return null;
  const tee = shotPoint(geometryInput.tee);
  const target = shotPoint(geometryInput.target);
  if ((geometryInput.tee != null && !tee) || (geometryInput.target != null && !target)) return null;
  if (typeof hole !== "number" || !Number.isInteger(hole) || hole < 1 || hole > 36 ||
      typeof scorerIndex !== "number" || !Number.isInteger(scorerIndex) || scorerIndex < 0 ||
      typeof targetId !== "string" || targetId.length < 1 || targetId.length > 200 ||
      typeof binding !== "string" || !/^\d+(?:,\d+)?$/.test(binding) || binding.length > 30 ||
      !validLedgerRevision(previous) || typeof order !== "string" || !validLedgerRevision(order) || previous === order || !rows) return null;
  return { hole, scorerIndex, targetId, binding, rows, recovery, previous, revision: order, geometry: { tee, target } };
}

function bookKey(generation: string, scorer: number): string {
  return `shot-book:${generation}:${scorer}`;
}

function view(cell: Cell): ShotLedger {
  const { receipts: _privateReceipts, ...visible } = cell;
  return visible;
}

export async function readShotLedgers(
  storage: LiveState["storage"], meta: LiveMeta | null, players: readonly PlayerState[], authMember?: string | null,
): Promise<ShotLedgerViews> {
  const generation = liveRecoveryId(meta);
  if (!generation || !meta?.shotLedgerScorers?.length) return {};
  const actorIndex = authMember === undefined ? null : players.findIndex((player) => player.memberId === authMember && !player.removed);
  const allowed = meta.shotLedgerScorers.filter((index) => {
    const scorer = players[index];
    return scorer && !scorer.removed && (actorIndex === null || index === actorIndex);
  });
  const books = await Promise.all(allowed.map((index) => storage.get<ShotBook>(bookKey(generation, index))));
  return Object.fromEntries(allowed.map((index, offset) => [index, Object.fromEntries(
    Object.entries(books[offset] ?? {}).map(([hole, cell]) => [hole, view(cell)]),
  )]));
}

type ShotEditContext = {
  getRound: () => { meta: LiveMeta | null; players: PlayerState[] };
  storage: LiveState["storage"];
  persist: (entries: Record<string, unknown>) => Promise<void>;
};

export async function saveShotLedger(body: unknown, identity: string | null, context: ShotEditContext): Promise<Response> {
  if (!identity) return j({ error: "not_on_card" }, 403);
  const edit = parseEdit(body);
  if (!edit) return j({ error: "bad_shot_ledger" }, 400);
  const roundId = edit.recovery.roundId;
  if (typeof roundId !== "string" || roundId !== liveRecoveryId(context.getRound().meta)) {
    return j({ error: "recovery_scope_changed" }, 409);
  }
  const bytes = text.encode(JSON.stringify([edit.targetId, edit.binding, edit.previous, edit.rows, edit.geometry]));
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))));
  const key = bookKey(roundId, edit.scorerIndex);
  const book = await context.storage.get<ShotBook>(key) ?? {};
  // Revalidate after the storage read. Once validated, compare and persist before yielding again.
  const { meta, players } = context.getRound();
  if (!meta) return j({ error: "not_live" }, 409);
  const actorIndex = players.findIndex((player) => player.memberId === identity && !player.removed);
  const actor = players[actorIndex];
  if (!actor) return j({ error: "not_on_card" }, 403);
  if (!matchesLiveRecoveryScope(edit.recovery, meta, actor, actorIndex)) return j({ error: "recovery_scope_changed" }, 409);
  const scorer = players[edit.scorerIndex];
  if (!scorer || edit.scorerIndex !== actorIndex) {
    return j({ error: "wrong_scorer" }, 403);
  }
  const prior = book[edit.hole];
  const receipt = prior?.receipts.find((item) => item.revision === edit.revision);
  if (receipt) {
    return receipt.actorIndex === actorIndex && receipt.digest === digest
      ? ledgerReply(edit, prior!, 200) : j({ error: "shot_request_reused" }, 409);
  }
  if (meta.status !== "live" || isCardLocked(meta.lockedCardIds, scorer.cardId)) {
    return j({ error: meta.status !== "live" ? "not_live" : "card_locked" }, 409);
  }
  const scoring = scoringState(meta, players);
  const target = healthyTargets(scoring).find((target) => target.id === edit.targetId && target.playerIndexes.includes(edit.scorerIndex));
  if (!target || target.playerIndexes.join(",") !== edit.binding || scoring.config.scoringStyle === "putting") {
    return j({ error: "shot_target_changed" }, 409);
  }
  if (!meta.holes.some((hole) => hole.hole === edit.hole)) return j({ error: "bad_hole" }, 400);
  if (edit.previous !== (prior?.revision ?? null)) return ledgerReply(edit, prior, 409);
  const sameTarget = prior?.targetId === edit.targetId && prior.binding === edit.binding;
  const entry: Cell = {
    revision: edit.revision, version: (prior?.version ?? 0) + 1, targetId: target.id, binding: edit.binding,
    scope: target.type === "pair" ? "team" : "player", label: target.label,
    geometry: sameTarget && prior.rows.length ? prior.geometry : edit.geometry,
    rows: edit.rows, receipts: [...(prior?.receipts ?? []).slice(-(RECEIPTS_PER_HOLE - 1)), { actorIndex, revision: edit.revision, digest }],
  };
  const indexes = meta.shotLedgerScorers ?? (meta.shotLedgerScorers = []);
  if (!indexes.includes(edit.scorerIndex)) indexes.push(edit.scorerIndex);
  await context.persist({ [key]: { ...book, [edit.hole]: entry } });
  return ledgerReply(edit, entry, 200);
}

function ledgerReply(edit: LedgerEdit, entry: Cell | undefined, status: 200 | 409): Response {
  return j({
    ...(status === 200 ? { ok: true } : { error: "recovery_edit_conflict" }),
    scorerIndex: edit.scorerIndex, hole: edit.hole, ledger: entry ? view(entry) : null,
  }, status);
}

export function finalizedShotLedger(
  all: ShotLedgerViews, players: PlayerState[], standing: FinalLiveStanding,
  meta: LiveMeta, holes: ResolvedHole[], legacy: Record<number, unknown>,
): { archive: Record<number, ArchivedShotLedger>; stats: ReturnType<typeof roundPlayStats> } | null {
  if (!standing.memberId) return null;
  const index = players.findIndex((player) => !player.removed && player.memberId === standing.memberId);
  const own = all[index];
  if (!own) return null;
  const scoring = scoringState(meta, players);
  const target = healthyTargets(scoring).find((target) => target.playerIndexes.includes(index));
  const archive = Object.fromEntries(Object.entries(own).filter(([, ledger]) => ledger.rows.length).map(([hole, ledger]) => [
    hole, { ...ledger, matchesResult: target?.id === ledger.targetId && target?.playerIndexes.join(",") === ledger.binding },
  ]));
  if (!Object.keys(archive).length) return null;
  const shots = { ...legacy };
  const geometries = holes.map((hole) => {
    const ledger = archive[hole.hole];
    if (!ledger?.matchesResult) return hole;
    shots[hole.hole] = ledger.rows;
    return shotHoleGeometry(hole, ledger);
  });
  const scores = Object.fromEntries(standing.holes.map((hole) => [hole.hole, hole.strokes]));
  return { archive, stats: roundPlayStats(geometries, shots, scores) };
}

export function archiveShotLedgerStmt(
  db: D1Like, archive: Record<number, ArchivedShotLedger>, memberId: string,
  result: { eventId: number } | { casualRoundId: number },
) {
  const event = "eventId" in result;
  const column = event ? "event_result_id" : "casual_result_id";
  const table = event ? "results" : "casual_results";
  const fk = event ? "event_id" : "casual_round_id";
  const round = event ? result.eventId : result.casualRoundId;
  return db.prepare(`INSERT INTO round_shot_ledgers (${column}, member_id, ledger_json)
    SELECT id, member_id, ? FROM ${table} WHERE ${fk} = ? AND member_id = ?`)
    .bind(JSON.stringify(archive), round, memberId);
}
