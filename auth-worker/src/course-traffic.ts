import type { Env } from "./env.js";
import * as db from "./db.js";
import { haversineFeet } from "./distance.js";

const MAX_ROUNDS = 24;
const MAX_AGE_MS = 14 * 60 * 60 * 1000;

export interface TrafficHole {
  hole: number;
  groups: number;
  players: number;
}

export interface CourseTraffic {
  courseId: number | null;
  name: string;
  lat: number | null;
  lng: number | null;
  groups: number;
  players: number;
  holes: TrafficHole[];
}

export interface TrafficPlayer {
  index: number;
  cardId?: string | null;
  scores?: Record<string, number | null> | null;
}

export interface TrafficLocation {
  index: number;
  lat: number;
  lng: number;
  fresh?: boolean;
}

export interface TrafficHolePoint {
  hole: number;
  tee?: { lat?: number | null; lng?: number | null } | null;
  target?: { lat?: number | null; lng?: number | null } | null;
}

export interface LiveTrafficRound {
  courseId?: number | null;
  name?: string | null;
  lat?: number | null;
  lng?: number | null;
  holes?: TrafficHolePoint[] | null;
  players?: TrafficPlayer[] | null;
  locations?: TrafficLocation[] | null;
}

function finite(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function coord(value: { lat?: number | null; lng?: number | null } | null | undefined) {
  const lat = finite(value?.lat);
  const lng = finite(value?.lng);
  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function scoreAt(scores: TrafficPlayer["scores"], hole: number): number | null {
  if (!scores || typeof scores !== "object") return null;
  const value = (scores as Record<string, unknown>)[hole] ?? (scores as Record<string, unknown>)[String(hole)];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function playingHole(holes: TrafficHolePoint[], scores: TrafficPlayer["scores"]): number | null {
  const ordered = holes.map((hole) => hole.hole).filter((hole) => Number.isInteger(hole) && hole >= 1 && hole <= 36);
  if (!ordered.length) return null;
  for (const hole of ordered) {
    if (scoreAt(scores, hole) == null) return hole;
  }
  return ordered[ordered.length - 1] ?? null;
}

function nearestHole(lat: number, lng: number, holes: TrafficHolePoint[]): number | null {
  let best: { hole: number; ft: number } | null = null;
  for (const hole of holes) {
    if (!Number.isInteger(hole.hole)) continue;
    for (const spot of [hole.tee, hole.target]) {
      const point = coord(spot);
      if (!point) continue;
      const ft = haversineFeet(point, { lat, lng });
      if (!best || ft < best.ft) best = { hole: hole.hole, ft };
    }
  }
  return best ? best.hole : null;
}

function playerHole(player: TrafficPlayer, location: TrafficLocation | undefined, holes: TrafficHolePoint[]): number | null {
  if (location && location.fresh !== false) {
    const lat = finite(location.lat);
    const lng = finite(location.lng);
    if (lat != null && lng != null) {
      const near = nearestHole(lat, lng, holes);
      if (near != null) return near;
    }
  }
  return playingHole(holes, player.scores);
}

function courseKey(courseId: number | null, name: string): string {
  if (courseId != null) return "id:" + courseId;
  return "name:" + name.trim().toLowerCase();
}

/** Hole counts only. No names, no pins. One card is one group, placed on the hole most of that card is on. */
export function trafficFromLiveRounds(rounds: readonly LiveTrafficRound[]): CourseTraffic[] {
  const courses = new Map<string, CourseTraffic & { holeMap: Map<number, TrafficHole> }>();
  for (const round of rounds) {
    const name = String(round?.name || "").trim() || "Course";
    const courseId = finite(round?.courseId);
    const key = courseKey(courseId, name);
    let course = courses.get(key);
    if (!course) {
      course = {
        courseId: courseId == null ? null : Math.round(courseId),
        name,
        lat: finite(round?.lat),
        lng: finite(round?.lng),
        groups: 0,
        players: 0,
        holes: [],
        holeMap: new Map(),
      };
      courses.set(key, course);
    }
    const holes = Array.isArray(round?.holes) ? round.holes : [];
    const locations = new Map<number, TrafficLocation>();
    for (const loc of round?.locations || []) {
      if (loc && Number.isInteger(loc.index)) locations.set(loc.index, loc);
    }
    const cards = new Map<string, TrafficPlayer[]>();
    for (const player of round?.players || []) {
      if (!player || !Number.isInteger(player.index)) continue;
      const card = player.cardId ? String(player.cardId) : "card";
      const list = cards.get(card) || [];
      list.push(player);
      cards.set(card, list);
    }
    for (const players of cards.values()) {
      const votes = new Map<number, number>();
      const placed: number[] = [];
      for (const player of players) {
        const hole = playerHole(player, locations.get(player.index), holes);
        if (hole == null) continue;
        placed.push(hole);
        votes.set(hole, (votes.get(hole) || 0) + 1);
      }
      if (!placed.length) continue;
      let groupHole = placed[0]!;
      let groupVotes = -1;
      for (const [hole, count] of votes) {
        if (count > groupVotes || (count === groupVotes && hole < groupHole)) {
          groupHole = hole;
          groupVotes = count;
        }
      }
      course.groups += 1;
      const group = course.holeMap.get(groupHole) || { hole: groupHole, groups: 0, players: 0 };
      group.groups += 1;
      course.holeMap.set(groupHole, group);
      for (const hole of placed) {
        course.players += 1;
        const row = course.holeMap.get(hole) || { hole, groups: 0, players: 0 };
        row.players += 1;
        course.holeMap.set(hole, row);
      }
    }
  }
  return [...courses.values()]
    .filter((course) => course.groups > 0)
    .map((course) => ({
      courseId: course.courseId,
      name: course.name,
      lat: course.lat,
      lng: course.lng,
      groups: course.groups,
      players: course.players,
      holes: [...course.holeMap.values()].sort((a, b) => a.hole - b.hole),
    }))
    .sort((a, b) => b.groups - a.groups || a.name.localeCompare(b.name));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function roundFromSnapshot(snapshot: unknown, hint: { course_id?: number | null; course_name?: string | null; lat?: number | null; lng?: number | null } | null): LiveTrafficRound | null {
  const snap = asRecord(snapshot);
  if (snap.status !== "live") return null;
  const courseId = finite(snap.courseId) ?? finite(hint?.course_id);
  const name = String(snap.courseName || hint?.course_name || "").trim();
  return {
    courseId: courseId == null ? null : Math.round(courseId),
    name: name || "Course",
    lat: finite(hint?.lat),
    lng: finite(hint?.lng),
    holes: Array.isArray(snap.holes) ? snap.holes as TrafficHolePoint[] : [],
    players: Array.isArray(snap.players) ? snap.players as TrafficPlayer[] : [],
    locations: Array.isArray(snap.playerLocations) ? snap.playerLocations as TrafficLocation[] : [],
  };
}

export async function noteLiveRound(env: Env, row: db.LiveRoundIndexRow): Promise<void> {
  try {
    await db.rememberLiveRound(env.DB, row);
  } catch (error) {
    console.error(JSON.stringify({ message: "live_round_index_write_failed", key: row.key, error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function dropLiveRound(env: Env, key: string): Promise<void> {
  try {
    await db.forgetLiveRound(env.DB, key);
  } catch (error) {
    console.error(JSON.stringify({ message: "live_round_index_delete_failed", key, error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function courseTrafficPayload(env: Env, now = Date.now()): Promise<{ courses: CourseTraffic[]; updatedAt: string }> {
  const indexed = await db.listLiveRoundIndex(env.DB).catch(() => [] as db.LiveRoundIndexRow[]);
  const liveEvents = await db.listLiveEvents(env.DB).catch(() => [] as { id?: number | string | null; course_id?: number | null; name?: string | null }[]);
  const keys = new Map<string, db.LiveRoundIndexRow>();
  for (const row of indexed) {
    if (row && row.key) keys.set(String(row.key), row);
  }
  for (const event of liveEvents) {
    const id = finite(event?.id);
    if (id == null) continue;
    const key = "event:" + Math.round(id);
    if (!keys.has(key)) {
      keys.set(key, { key, course_id: finite(event.course_id), course_name: null, started_at: null });
    }
  }
  const rows = [...keys.values()].slice(0, MAX_ROUNDS);
  const rounds = (await Promise.all(rows.map(async (row) => {
    const started = Date.parse(String(row.started_at || ""));
    // Too old to be out on the course: leave it off the traffic board, but keep it in the index so Admin › Live
    // rounds can still find it (a ghost card stays "live" until it's finished or an admin ends it).
    if (Number.isFinite(started) && now - started > MAX_AGE_MS) return null;
    try {
      const stub = env.LIVE.get(env.LIVE.idFromName(row.key));
      const response = await stub.fetch("https://do/snapshot");
      const body = await response.json().catch(() => null);
      const round = roundFromSnapshot(body, row);
      if (!round) {
        await dropLiveRound(env, row.key);
        return null;
      }
      return round;
    } catch {
      return null;
    }
  }))).filter((round): round is LiveTrafficRound => round != null);
  return { courses: trafficFromLiveRounds(rounds), updatedAt: new Date(now).toISOString() };
}
