import type { LiveMeta } from "./live-types.js";
import type { PlayerState } from "./scoring.js";

export function liveRecoveryId(meta: LiveMeta | null): string | null {
  return meta ? meta.recoveryRoundId || meta.startedAt || "legacy" : null;
}

export function matchesLiveRecoveryScope(
  value: unknown, meta: LiveMeta, actor: PlayerState | undefined, actorIndex: number,
): boolean {
  if (!value || typeof value !== "object" || !actor) return false;
  const body = value as Record<string, unknown>;
  return body.roundId === liveRecoveryId(meta) && body.actorIndex === actorIndex
    && body.cardId === (actor.cardId ?? null);
}

type RecoveryCheck = { key: string; order: string; duplicate: boolean; previous: unknown };
export function checkLiveRecovery(
  value: unknown,
  meta: LiveMeta,
  actor: PlayerState | undefined,
  actorIndex: number,
  cell: unknown[],
): RecoveryCheck | "invalid_recovery" | "recovery_scope_changed" | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") return "invalid_recovery";
  const body = value as Record<string, unknown>;
  if (typeof body.stream !== "string" || !/^[0-9a-f-]{36}$/.test(body.stream)
      || typeof body.order !== "string" || !/^\d{16}:[0-9a-f-]{36}$/.test(body.order)) return "invalid_recovery";
  if (!matchesLiveRecoveryScope(body, meta, actor, actorIndex)) return "recovery_scope_changed";
  const key = JSON.stringify([body.stream, ...cell]);
  const last = actor?.recoveryOrders?.[key];
  return { key, order: body.order, duplicate: Boolean(last && last >= body.order), previous: body.previous };
}

export function recordLiveRecovery(actor: PlayerState | undefined, check: RecoveryCheck | null): void {
  if (!actor || !check) return;
  const orders = actor.recoveryOrders ?? (actor.recoveryOrders = {});
  orders[check.key] = check.order;
}
