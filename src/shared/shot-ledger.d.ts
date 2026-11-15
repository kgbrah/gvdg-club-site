export type ShotLie = "unknown" | "tee" | "fairway" | "rough" | "ob" | "drop-zone" | "basket";
export type ShotPoint = { lat: number; lng: number; accuracyM?: number; observedAt?: number };
type ShotCommon = { id: string; recordedAt?: number; landingLie: ShotLie; landing?: ShotPoint };
export type ShotRecord = (ShotCommon & { kind: "penalty" }) | (ShotCommon & {
  kind: "throw"; attempt: "unknown" | "throw" | "putt"; outcome: "unknown" | "missed" | "made";
  originLie: ShotLie; origin?: ShotPoint; distanceFt?: number; distanceSource?: "gps" | "manual";
  puttDistanceFt?: number; fairway?: boolean; outOfBounds?: boolean;
});
export type ShotLedger = {
  revision: string; version: number; targetId: string; binding: string; scope: "player" | "team"; label: string;
  geometry: { tee: ShotPoint | null; target: ShotPoint | null }; rows: ShotRecord[];
};
export const MAX_LEDGER_STROKES: 30;
export const SHOT_LIES: readonly ShotLie[];
export const SHOT_OUTCOMES: readonly ("unknown" | "missed" | "made")[];
export const SHOT_ATTEMPTS: readonly ("unknown" | "throw" | "putt")[];
export const NO_SHOT_ROWS: readonly ShotRecord[];
export const SHOT_LABELS: Readonly<Record<string, string>>;
export function describeShot(row: ShotRecord): string;
export function shotPoint(value: unknown): ShotPoint | null;
export function parseShotRows(value: unknown): ShotRecord[] | null;
export function validLedgerRevision(value: unknown): value is string | null;
export function shotHoleGeometry<T>(hole: T, ledger: ShotLedger | null | undefined): T | (T & {
  tee: ShotPoint | null; target: ShotPoint | null; basket: null;
});
export function shotLedgerQuality(rows: readonly ShotRecord[], score: number | null): "unscored" | "different-count" | "unknown-outcome" | "unknown-attempt" | "missing-finish" | "complete" | "empty";
