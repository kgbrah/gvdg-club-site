export type Coverage = "listed" | "scorable" | "partial" | "full";
export type QualityHole = {
  hole: number;
  par: number | null;
  parSource: "missing" | "tee-sign" | "placeholder" | "udisc" | "recorded";
  tee: boolean;
  basket: boolean;
  mapped: boolean;
  missing: Array<"tee" | "basket" | "distinct-positions" | "par" | "confirmed-par">;
};
export type Quality = {
  status: Coverage;
  holeCount: number;
  mappedCount: number;
  invalidRows: number;
  unlistedHoles: number;
  placeholderPars: number;
  teeSignPars: number;
  scorable: boolean;
  holes: QualityHole[];
};
export const COVERAGE_LABELS: Readonly<Record<Coverage, string>>;
export const COVERAGE_ORDER: Readonly<Record<Coverage, number>>;
export function mapCoordinates(value: unknown): { lat: number; lng: number } | null;
export function mappedHole(hole: unknown): boolean;
export function layoutRows(layout: unknown): unknown[];
export function layoutQuality(layout: unknown): Quality;
export function courseCoverage(course: unknown): Coverage;
export function layoutRevision(layout: unknown): string;
