import type { D1Like } from "./db.js";

type CountKey = "event_config" | "registrations" | "event_players" | "results" | "ctps" | "wallet_transactions" | "ace_pots";

type CountRow = {
  readonly n?: number | string | null;
};

type EventStatusRow = {
  readonly status?: string | null;
};

type DeleteBlockerQuery = {
  readonly key: CountKey;
  readonly sql: string;
};

export type EventDeletionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "not_found" | "event_delete_blocked"; readonly blockers: readonly string[] };

const DELETE_BLOCKER_QUERIES: readonly DeleteBlockerQuery[] = [
  { key: "event_config", sql: "SELECT COUNT(*) AS n FROM event_config WHERE event_id = ?" },
  { key: "registrations", sql: "SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?" },
  { key: "event_players", sql: "SELECT COUNT(*) AS n FROM event_players WHERE event_id = ?" },
  { key: "results", sql: "SELECT COUNT(*) AS n FROM results WHERE event_id = ?" },
  { key: "ctps", sql: "SELECT COUNT(*) AS n FROM ctps WHERE event_id = ?" },
  { key: "wallet_transactions", sql: "SELECT COUNT(*) AS n FROM wallet_transactions WHERE event_id = ?" },
  { key: "ace_pots", sql: "SELECT COUNT(*) AS n FROM ace_pots WHERE event_id = ?" },
];

export function isLifecycleManagedStatus(status: string | null | undefined): boolean {
  return status === "live" || status === "final";
}

function countValue(row: CountRow | null): number {
  const value = row?.n;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function countRows(db: D1Like, sql: string, eventId: number): Promise<number> {
  return countValue(await db.prepare(sql).bind(eventId).first<CountRow>());
}

export async function checkEventDeletion(db: D1Like, eventId: number): Promise<EventDeletionCheck> {
  const event = await db.prepare("SELECT status FROM events WHERE id = ?").bind(eventId).first<EventStatusRow>();
  if (!event) return { ok: false, error: "not_found", blockers: [] };

  const blockers: string[] = [];
  if (isLifecycleManagedStatus(event.status)) blockers.push("status:" + event.status);

  for (const query of DELETE_BLOCKER_QUERIES) {
    if (await countRows(db, query.sql, eventId) > 0) blockers.push(query.key);
  }

  return blockers.length ? { ok: false, error: "event_delete_blocked", blockers } : { ok: true };
}
