import type { Env } from "./env.js";
import * as db from "./db.js";
import { json } from "./http.js";
import { isLoggedInMemberId, locationOnCourse, courseLocationBounds } from "./live-locations.js";
import {
  applyMapConsensus,
  holeAnchor,
  mapMarkAccuracyOk,
  mapMarkNearAnchor,
  parseMapMarkBody,
} from "./course-map-marks.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { fillMissingHolePins, holesFromPositionLabels, markerHasPin } from "./hole-pins.js";
import type { ScorableHole } from "./db-courses.js";

const MAP_MARK_LIMIT = 40;
const MAP_MARK_WINDOW_SEC = 3600;

type LiveHole = {
  hole: number;
  tee?: { lat?: number | null; lng?: number | null } | null;
  target?: { lat?: number | null; lng?: number | null } | null;
};

type LiveSnapshot = {
  status?: string;
  layoutId?: number | null;
  courseId?: number | null;
  eventId?: number | null;
  holes?: LiveHole[];
  players?: { memberId?: string | null }[];
};

export async function overlayLiveSnapshot(env: Env, snapshot: Record<string, unknown>): Promise<Record<string, unknown>> {
  const holes = snapshot.holes;
  if (!Array.isArray(holes)) return snapshot;
  let layoutId = Number(snapshot.layoutId);
  let courseId = Number(snapshot.courseId);
  const layoutOk = Number.isInteger(layoutId) && layoutId > 0;
  const courseOk = Number.isInteger(courseId) && courseId > 0;
  if (!layoutOk && !courseOk) return snapshot;

  const needsPins = holes.some((hole) => {
    const row = hole as LiveHole;
    return !markerHasPin(row?.tee) || !markerHasPin(row?.target);
  });
  let next = holes as LiveHole[];
  // Every card load runs this: the reads go out together instead of one after another (each is a D1 round trip).
  const consensusRead = layoutOk ? db.listPublishedConsensus(env.DB, layoutId) : Promise.resolve([]);
  let consensus: Awaited<typeof consensusRead>;
  if (needsPins) {
    const courseRead = courseOk
      ? Promise.resolve(courseId)
      : layoutOk
        ? db.getLayout(env.DB, layoutId).then((layout) => Number((layout as { course_id?: number | null } | null)?.course_id))
        : Promise.resolve(Number.NaN);
    const [found, rawHoles, positions] = await Promise.all([
      consensusRead,
      layoutOk ? db.getLayoutHoles(env.DB, layoutId) : Promise.resolve([] as LiveHole[]),
      courseRead.then((id) => {
        courseId = id;
        return Number.isInteger(id) && id > 0 ? db.listPositions(env.DB, id) : [];
      }),
    ]);
    consensus = found;
    const layoutHoles = consensus.length ? applyMapConsensus(rawHoles as LiveHole[], consensus) : rawHoles as LiveHole[];
    next = fillMissingHolePins(next, [holesFromPositionLabels(positions), layoutHoles]);
  } else {
    consensus = await consensusRead;
  }
  if (consensus.length) next = applyMapConsensus(next, consensus);
  if (next === holes) return snapshot;
  return { ...snapshot, holes: next };
}

/** Layout holes for a new live round, with blank tees/baskets filled from "Hole N tee/basket" positions. */
export async function liveHolesWithPins(env: Env, layoutId: number | null | undefined): Promise<ScorableHole[]> {
  const holes = await db.layoutHolesWithCrowdMap(env.DB, layoutId);
  if (!holes.some((hole) => !markerHasPin(hole.tee) || !markerHasPin(hole.target))) return holes;
  const id = Number(layoutId);
  if (!Number.isInteger(id) || id <= 0) return holes;
  const layout = (await db.getLayout(env.DB, id)) as { course_id?: number | null } | null;
  const courseId = Number(layout?.course_id);
  if (!Number.isInteger(courseId) || courseId <= 0) return holes;
  const positions = await db.listPositions(env.DB, courseId);
  return fillMissingHolePins(holes, [holesFromPositionLabels(positions)]);
}

export async function submitLiveMapMark(options: {
  env: Env;
  origin: string | null;
  memberId: string;
  roundCode?: string | null;
  snapshot: LiveSnapshot;
  body: unknown;
  overlay: (patch: { hole: number; kind: "tee" | "target"; lat: number; lng: number }) => Promise<void>;
}): Promise<Response> {
  const { env, origin, memberId, snapshot, body, overlay } = options;
  if (!isLoggedInMemberId(memberId) || memberId.startsWith("op_")) return json({ error: "forbidden" }, 403, origin);
  if (snapshot.status !== "live") return json({ error: "not_live" }, 409, origin);
  const onCard = (snapshot.players || []).some((player) => player && player.memberId === memberId);
  if (!onCard) return json({ error: "forbidden" }, 403, origin);
  if (await kvRateLimited(env, "map-mark:" + memberId, MAP_MARK_LIMIT, MAP_MARK_WINDOW_SEC)) {
    return json({ error: "rate_limited" }, 429, origin);
  }

  const parsed = parseMapMarkBody(body);
  if (!parsed) return json({ error: "invalid_mark" }, 400, origin);
  if (!mapMarkAccuracyOk(parsed.accuracyM)) return json({ error: "gps_inaccurate" }, 400, origin);

  const hole = (snapshot.holes || []).find((row) => row.hole === parsed.hole);
  if (!hole) return json({ error: "bad_hole" }, 400, origin);
  const bounds = courseLocationBounds(snapshot.holes || []);
  if (bounds && !locationOnCourse(parsed.lat, parsed.lng, snapshot.holes || [])) {
    return json({ error: "off_course" }, 400, origin);
  }
  const anchor = holeAnchor(hole, parsed.kind);
  if (!mapMarkNearAnchor(parsed, anchor)) return json({ error: "too_far" }, 400, origin);

  let layoutId = Number(snapshot.layoutId);
  let courseId = Number(snapshot.courseId);
  if (!Number.isInteger(layoutId) || layoutId <= 0) {
    const eventId = Number(snapshot.eventId);
    if (Number.isInteger(eventId) && eventId > 0) {
      const event = (await db.getEvent(env.DB, eventId)) as { layout_id?: number | null } | null;
      layoutId = Number(event?.layout_id);
    }
  }
  if (!Number.isInteger(layoutId) || layoutId <= 0) return json({ error: "no_layout" }, 409, origin);
  if (!Number.isInteger(courseId) || courseId <= 0) {
    const layout = (await db.getLayout(env.DB, layoutId)) as { course_id?: number | null } | null;
    courseId = Number(layout?.course_id);
  }
  if (!Number.isInteger(courseId) || courseId <= 0) return json({ error: "no_layout" }, 409, origin);

  await db.upsertCourseMapMark(env.DB, {
    course_id: courseId,
    layout_id: layoutId,
    hole: parsed.hole,
    kind: parsed.kind,
    lat: parsed.lat,
    lng: parsed.lng,
    accuracy_m: parsed.accuracyM,
    member_id: memberId,
    round_code: options.roundCode ?? null,
  });
  const unmapped = !holeAnchor(hole, parsed.kind);
  const consensus = await db.recomputeCourseMapConsensus(env.DB, layoutId, parsed.hole, parsed.kind, { unmapped });
  if (consensus.published) {
    await overlay({ hole: parsed.hole, kind: parsed.kind, lat: consensus.lat, lng: consensus.lng });
  }
  return json({
    ok: true,
    hole: parsed.hole,
    kind: parsed.kind,
    point: { lat: parsed.lat, lng: parsed.lng },
    samples: consensus.samples,
    members: consensus.members,
    published: consensus.published,
    consensus: consensus.published ? { lat: consensus.lat, lng: consensus.lng } : null,
  }, 200, origin);
}
