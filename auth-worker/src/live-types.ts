import type * as db from "./db.js";
import type { LiveScoringConfig, ScoreTarget } from "./live-format.js";

export interface LiveEnv {
  DB: db.D1Like;
}

export type LiveSocket = {
  send(message: string): void;
};

export interface LiveState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
  acceptWebSocket(socket: LiveSocket): void;
  getWebSockets(): LiveSocket[];
}

export interface LiveMeta {
  eventId: number;
  casual?: boolean;
  roundCode?: string | null;
  courseId?: number | null;
  layoutId?: number | null;
  createdBy?: string | null;
  courseName?: string | null;
  layoutName?: string | null;
  udiscCourseId?: string | null;
  holes: { hole: number; par: number; distance_ft?: number | null; tee_sign_id?: number | null }[];
  status: "live" | "final";
  startedAt: string;
  roundConfig?: LiveScoringConfig;
  rev?: number;
  overrides?: Record<string, { par?: number; distance_ft?: number }>;
}

export interface StartBody {
  eventId?: number;
  casual?: boolean;
  roundCode?: string | null;
  courseId?: number | null;
  layoutId?: number | null;
  createdBy?: string | null;
  courseName?: string | null;
  layoutName?: string | null;
  udiscCourseId?: string | null;
  holes: { hole: number; par: number; distance_ft?: number | null; tee_sign_id?: number | null }[];
  liveScoringConfig?: LiveScoringConfig;
  players: { memberId?: string | null; name: string; division?: string | null; team?: string | null; pairLabel?: string | null; startingHole?: number | null; cardId?: string | null }[];
  startedAt?: string;
  cardSize?: number;
}

export interface ScoreBody {
  memberId?: string | null;
  index?: number;
  targetId?: string;
  name?: string;
  scorerIndex?: number | null;
  hole: number;
  strokes: number;
}

export interface OverrideBody {
  hole: number;
  par?: number | null;
  distance_ft?: number | null;
  clear?: boolean;
}

export interface RemoveBody {
  memberId?: string | null;
  index?: number;
  name?: string;
}

export interface PairAssignmentBody {
  assignments?: { index?: number; pairLabel?: string | null; label?: string | null; team?: string | null }[];
  pairs?: { label?: string | null; pairLabel?: string | null; team?: string | null; playerIndexes?: number[] }[];
}

export type ResolvedHole = {
  readonly hole: number;
  readonly par: number;
  readonly distance_ft: number | null;
  readonly tee_sign_id: number | null;
  readonly overridden: boolean;
};

export type ScoringState =
  | { readonly config: LiveScoringConfig; readonly targets: readonly ScoreTarget[]; readonly error: null }
  | { readonly config: LiveScoringConfig; readonly targets: readonly ScoreTarget[]; readonly error: { readonly code: string; readonly message: string } };

export type PublicScoreTarget = {
  readonly id: string;
  readonly type: ScoreTarget["type"];
  readonly label: string;
  readonly playerIndexes: readonly number[];
  readonly members: readonly string[];
};

export const j = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export function metadataJson(value: unknown | undefined): string | null {
  return value == null ? null : JSON.stringify(value);
}
