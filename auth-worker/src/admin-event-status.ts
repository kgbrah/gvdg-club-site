import { isLifecycleManagedStatus } from "./admin-event-safety.js";
import * as db from "./db.js";
import { EVENT_STATUSES } from "./db.js";
import { json } from "./http.js";
import { inSet } from "./input.js";

type EventStatusPatchInput = {
  readonly database: db.D1Like;
  readonly eventId: number;
  readonly body: Record<string, unknown>;
  readonly origin: string | null;
};

type ConfirmEventStatusPatchInput = {
  readonly currentStatus: string | null;
  readonly body: Record<string, unknown>;
  readonly origin: string | null;
};

export type EventStatusPatchResult =
  | { readonly ok: true; readonly status: string }
  | { readonly ok: false; readonly response: Response };

export function confirmEventStatusPatch(input: ConfirmEventStatusPatchInput): EventStatusPatchResult {
  const status = input.body.status;
  if (!inSet(EVENT_STATUSES, status)) return { ok: false, response: json({ error: "invalid_event" }, 400, input.origin) };
  if (isLifecycleManagedStatus(status)) return { ok: false, response: json({ error: "lifecycle_status_requires_live_flow" }, 409, input.origin) };

  if (input.currentStatus == null) return { ok: false, response: json({ error: "not_found" }, 404, input.origin) };
  if (isLifecycleManagedStatus(input.currentStatus)) return { ok: false, response: json({ error: "lifecycle_status_requires_live_flow" }, 409, input.origin) };
  if (input.currentStatus !== status && input.body.confirm_event_status_change !== true) {
    return { ok: false, response: json({ error: "event_status_confirmation_required" }, 409, input.origin) };
  }

  return { ok: true, status };
}

export async function readConfirmedEventStatusPatch(input: EventStatusPatchInput): Promise<EventStatusPatchResult> {
  const currentStatus = await db.getEventStatus(input.database, input.eventId);
  return confirmEventStatusPatch({ currentStatus, body: input.body, origin: input.origin });
}
