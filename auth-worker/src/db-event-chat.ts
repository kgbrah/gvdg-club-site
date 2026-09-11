import type { D1Like } from "./db-types.js";
import { readD1OrFallback } from "./d1-retry.js";

export interface EventChatInput {
  event_id: number;
  member_id?: string | null;
  author_name: string;
  body: string;
}

const PUBLIC_COLUMNS = "id, event_id, author_name, body, created_at";

export async function listEventChat(db: D1Like, eventId: number, limit = 100) {
  return (await readD1OrFallback(
    () =>
      db
        .prepare(
          `SELECT ${PUBLIC_COLUMNS}
             FROM event_chat
            WHERE event_id = ?
            ORDER BY id DESC
            LIMIT ?`,
        )
        .bind(eventId, limit)
        .all(),
    () => ({ results: [], success: true }),
  )).results;
}

export async function createEventChat(db: D1Like, input: EventChatInput) {
  return db
    .prepare(
      "INSERT INTO event_chat (event_id, member_id, author_name, body) VALUES (?, ?, ?, ?) RETURNING id, event_id, author_name, body, created_at",
    )
    .bind(input.event_id, input.member_id ?? null, input.author_name, input.body)
    .first();
}
