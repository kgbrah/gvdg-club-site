import * as clubDb from "./db.js";
import {
  clearRoundRatingsForCasualRound,
  clearRoundRatingsForEvent,
  createRoundRating,
  getLayoutRatingBaseline,
  upsertLayoutRatingBaseline,
  upsertPlayerRatingFromRounds,
  type LayoutRatingBaseline,
  type RoundRatingInput,
} from "./rating-store.js";
import { roundRatingForScoreWithWeather, solveSsa, type RatingMethod, type RatingStream, type RatingWeather } from "./ratings.js";
import type { FinalStanding, PlayerState } from "./scoring.js";
import { ratingWeatherFromJson } from "./weather.js";

export type FinalizedRoundMeta = {
  readonly eventId: number;
  readonly casual: boolean;
  readonly roundCode: string | null;
  readonly courseId: number | null;
  readonly layoutId: number | null;
  readonly createdBy: string | null;
  readonly courseName: string | null;
  readonly layoutName: string | null;
  readonly startedAt: string;
  readonly holesJson: string | null;
  readonly weatherJson: string | null;
};

export type PersistFinalizedRoundInput = {
  readonly db: clubDb.D1Like;
  readonly meta: FinalizedRoundMeta;
  readonly standings: readonly FinalStanding[];
  readonly players: readonly PlayerState[];
};

type RatingContext = LayoutRatingBaseline & {
  readonly ratingMethod: RatingMethod;
};

type RatedStanding = {
  readonly standing: FinalStanding;
  readonly roundRating: number | null;
  readonly ratingSsa: number | null;
  readonly ratingPpt: number | null;
  readonly windGustMph: number | null;
  readonly weatherAdjustment: number;
};

export async function persistFinalizedRound(input: PersistFinalizedRoundInput): Promise<void> {
  const stream: RatingStream = input.meta.casual ? "casual" : "competition";
  if (input.meta.casual && !input.meta.roundCode) return;
  const context = await ratingContext(input);
  const ratingWeather = ratingWeatherFromJson(input.meta.weatherJson);
  const rated = input.standings.map((standing) => rateStanding(standing, context, ratingWeather));
  if (input.meta.casual) {
    await persistCasualRatings(input, stream, rated, context);
    return;
  }
  await persistCompetitionResults(input, stream, rated, context);
}

async function persistCompetitionResults(
  input: PersistFinalizedRoundInput,
  stream: RatingStream,
  rated: readonly RatedStanding[],
  context: RatingContext | null,
): Promise<void> {
  await clubDb.clearResults(input.db, input.meta.eventId);
  await clearRoundRatingsForEvent(input.db, input.meta.eventId);
  await Promise.all(
    rated.map((row) =>
      clubDb.createResult(input.db, {
        event_id: input.meta.eventId,
        member_id: row.standing.memberId,
        name: row.standing.name,
        place: row.standing.place,
        total: row.standing.total,
        to_par: row.standing.toPar,
        rating: row.roundRating,
        breakdown: JSON.stringify(row.standing.breakdown),
        scorecard: row.standing.holes.length ? JSON.stringify(row.standing.holes) : null,
        weather: input.meta.weatherJson,
      }),
    ),
  );
  await persistRoundRatingRows(input, stream, rated, context);
  if (context && input.meta.layoutId != null) {
    await upsertLayoutRatingBaseline(input.db, { layoutId: input.meta.layoutId, eventId: input.meta.eventId, baseline: context });
  }
  await clubDb.updateEvent(input.db, input.meta.eventId, { status: "final" });
}

async function persistCasualRatings(
  input: PersistFinalizedRoundInput,
  stream: RatingStream,
  rated: readonly RatedStanding[],
  context: RatingContext | null,
): Promise<void> {
  if (!input.meta.roundCode) return;
  await clearRoundRatingsForCasualRound(input.db, input.meta.roundCode);
  await clubDb.clearCasualRound(input.db, input.meta.roundCode);
  const round = (await clubDb.createCasualRound(input.db, {
    round_code: input.meta.roundCode,
    course_id: input.meta.courseId,
    layout_id: input.meta.layoutId,
    course_name: input.meta.courseName,
    layout_name: input.meta.layoutName,
    holes: input.meta.holesJson,
    created_by: input.meta.createdBy,
    started_at: input.meta.startedAt || null,
  })) as { readonly id?: number } | null;
  const roundId = round?.id;
  if (!roundId) throw new Error("casual_round_insert_failed");
  await Promise.all(
    rated.map((row) =>
      clubDb.createCasualResult(input.db, {
        casual_round_id: roundId,
        member_id: row.standing.memberId,
        name: row.standing.name,
        division: row.standing.division,
        place: row.standing.place,
        total: row.standing.total,
        to_par: row.standing.toPar,
        breakdown: JSON.stringify(row.standing.breakdown),
        scorecard: row.standing.holes.length ? JSON.stringify(row.standing.holes) : null,
      }),
    ),
  );
  await persistRoundRatingRows(input, stream, rated, context);
}

async function persistRoundRatingRows(
  input: PersistFinalizedRoundInput,
  stream: RatingStream,
  rated: readonly RatedStanding[],
  context: RatingContext | null,
): Promise<void> {
  const rows = rated.flatMap((row) => roundRatingRow(input.meta, stream, row, context));
  await Promise.all(rows.map((row) => createRoundRating(input.db, row)));
  const members = [...new Set(rows.map((row) => row.memberId))];
  const now = new Date().toISOString();
  await Promise.all(members.map((memberId) => upsertPlayerRatingFromRounds(input.db, { memberId, stream, now })));
}

async function ratingContext(input: PersistFinalizedRoundInput): Promise<RatingContext | null> {
  if (input.meta.casual) {
    const baseline = await getLayoutRatingBaseline(input.db, input.meta.layoutId);
    if (baseline) return { ...baseline, ratingMethod: "layout" };
  }
  const solved = solveSsa(propagators(input.standings, input.players));
  return solved
    ? { ssa: solved.ssa, ppt: solved.ppt, propagatorCount: solved.propagatorCount, ratingMethod: solved.status }
    : null;
}

function propagators(standings: readonly FinalStanding[], players: readonly PlayerState[]) {
  const anchors = new Map<string, number>();
  for (const player of players) {
    if (!player.memberId || player.ratingAnchor == null || !Number.isFinite(player.ratingAnchor)) continue;
    anchors.set(player.memberId, player.ratingAnchor);
  }
  return standings.flatMap((standing) => {
    if (!standing.memberId || standing.place == null) return [];
    const rating = anchors.get(standing.memberId);
    return rating == null ? [] : [{ score: standing.total, rating }];
  });
}

function rateStanding(standing: FinalStanding, context: RatingContext | null, ratingWeather: RatingWeather): RatedStanding {
  const completed = standing.place != null;
  if (!completed || !context) {
    return {
      standing,
      roundRating: null,
      ratingSsa: null,
      ratingPpt: null,
      windGustMph: ratingWeather.windGustMph,
      weatherAdjustment: 0,
    };
  }
  const rated = roundRatingForScoreWithWeather({
    score: standing.total,
    ssa: context.ssa,
    ppt: context.ppt,
    weather: context.ratingMethod === "layout" ? ratingWeather : null,
  });
  return {
    standing,
    roundRating: rated.roundRating,
    ratingSsa: rated.ssa,
    ratingPpt: rated.ppt,
    windGustMph: ratingWeather.windGustMph,
    weatherAdjustment: rated.weatherAdjustment,
  };
}

function roundRatingRow(
  meta: FinalizedRoundMeta,
  stream: RatingStream,
  rated: RatedStanding,
  context: RatingContext | null,
): readonly RoundRatingInput[] {
  if (!rated.standing.memberId || rated.standing.place == null) return [];
  return [{
    memberId: rated.standing.memberId,
    playerName: rated.standing.name,
    stream,
    eventId: meta.casual ? null : meta.eventId,
    casualRoundCode: meta.casual ? meta.roundCode : null,
    courseId: meta.courseId,
    layoutId: meta.layoutId,
    roundDate: roundDate(meta.startedAt),
    total: rated.standing.total,
    toPar: rated.standing.toPar,
    roundRating: rated.roundRating,
    ssa: rated.ratingSsa,
    ppt: rated.ratingPpt,
    windGustMph: rated.windGustMph,
    weatherAdjustment: rated.weatherAdjustment,
    propagatorCount: context?.propagatorCount ?? 0,
    ratingMethod: context?.ratingMethod ?? "unrated",
  }];
}

function roundDate(startedAt: string): string {
  return Number.isFinite(Date.parse(startedAt)) ? startedAt : new Date().toISOString();
}
