export const SHOT_STATS_VERSION: string;
export const TAP_IN_METERS: number;
export const CIRCLE1_M: number;
export const CIRCLE2_M: number;
export const PARKED_FT: number;
export const FAIRWAY_WIDTH_FT: number;
export const SHOT_STAT_DEFINITIONS: Readonly<Record<string, string | number>>;
export type ShotSample = { att: number; hit: number };
export type ShotQuality = "unscored" | "not-applicable" | "missing" | "incomplete" | "estimated" | "recorded";
export type HoleShotStats = {
  fir: ShotSample | null; c1r: ShotSample | null; c2r: ShotSample | null; parked: ShotSample | null;
  scramble: ShotSample | null; c1Putt: ShotSample | null; c1xPutt: ShotSample | null; c2Putt: ShotSample | null;
  shotQuality: ShotQuality;
};
export function fairwayHit(drive: unknown, tee: unknown, basket: unknown): boolean | null;
export function lineOffsetFt(point: unknown, tee: unknown, target: unknown): number | null;
export function regulationStrokes(par: unknown): number;
export function puttingBuckets(meters: unknown): Array<"c1Putt" | "c1xPutt" | "c2Putt">;
export function holePlayStats(hole: unknown, throws: unknown, score: unknown): HoleShotStats;
