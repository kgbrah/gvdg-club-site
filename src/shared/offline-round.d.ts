import type { ShotRecord } from "./shot-ledger.js";

export type OfflineOwner = { kind: "member" | "open"; id: string };
type Marker = { label: string; lat: number | null; lng: number | null };
type OfflineHole = { hole: number; par: number; par_source: string | null; distance_ft: number | null; distance_source: string | null; tee: Marker | null; target: Marker | null };
type Format = { groupFormat: "singles" | "doubles"; scoringStyle: "stroke" | "matchplay" };
type Target = { id: string; type: "player" | "pair"; label: string; playerIndexes: number[]; members: string[] };
export type OfflineRound = {
  version: 1; localId: string; owner: OfflineOwner; startedAs: "account" | "device";
  source: { courseId: number; courseName: string; layoutId: number; layoutName: string; savedAt: string; revision: string; contentRevision: string; holes: OfflineHole[] };
  format: Format; players: { id: string; name: string }[]; startedAt: string; finishedAt: string;
  scores: Record<string, Record<number, number>>; shots: Record<number, ShotRecord[]>;
  marks: Record<number, { lat: number; lng: number; n: number }[]>;
};
export const MAX_OFFLINE_PLAYERS: 16;
export const OFFLINE_ROUND_VERSION: 1;
export const OFFLINE_ID: RegExp;
export function offlineOwner(value: unknown): OfflineOwner | null;
export function offlineLayoutSnapshot(pack: unknown): OfflineRound["source"] | null;
export function offlineTargets(round: Pick<OfflineRound, "format" | "players">): Target[];
export function offlineRoundOutcome(round: Pick<OfflineRound, "source" | "format" | "players" | "scores">): {
  missing: { hole: number; targetId: string; playerName: string; label: string }[];
  complete: boolean; summaries: (Target & { thru: number; total: number; toPar: number })[]; requiredHoles: number[];
  match: { played: number; lead: number; remaining: number; final: boolean; leader: string | null; label: string } | null;
};
export function parseOfflineRound(value: unknown): OfflineRound | null;
