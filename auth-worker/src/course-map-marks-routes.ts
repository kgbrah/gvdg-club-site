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
  const layoutId = Number(snapshot.layoutId);
  if (!Number.isInteger(layoutId) || layoutId <= 0) return snapshot;
  const consensus = await db.listPublishedConsensus(env.DB, layoutId);
  if (!consensus.length || !Array.isArray(snapshot.holes)) return snapshot;
  return { ...snapshot, holes: applyMapConsensus(snapshot.holes as LiveHole[], consensus) };
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
  const consensus = await db.recomputeCourseMapConsensus(env.DB, layoutId, parsed.hole, parsed.kind);
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
