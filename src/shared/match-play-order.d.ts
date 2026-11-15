type MatchHole = { readonly hole: number };
type Cardmate = { readonly startingHole?: number | null };
type Score = number | null | undefined;

export function matchPlayStartHole(holes: readonly MatchHole[], cardmates: readonly Cardmate[]): number | null;
export function requiredMatchPlayHoles<H extends MatchHole>(holes: H[], start: number | null, scoresAt: (hole: number) => readonly [Score, Score]): H[];
