export const ACTIVITY_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const ACTIVITY_MAX_POINTS = 4096;
const MAX_DURATION = 24 * 60 * 60 * 1000;
const MIN_DATE = Date.UTC(2026, 0, 1);
const MAX_DATE = Date.UTC(2100, 0, 1);
const MAX_GAP = 90_000;

type Point = { at: number; lat: number; lng: number; accuracyM: number };
export type ActivityTrack = {
  version: 1; clientId: string; ownerId: string; startedAt: number; stoppedAt: number;
  round: { key: string; generation: string } | null; segments: Point[][];
};

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function validActivityRoundKey(value: unknown): value is string {
  return typeof value === "string" && /^(?:round:[A-Z0-9]{4,12}|event:[1-9]\d{0,14})$/.test(value);
}

export function parseActivityTrack(body: Record<string, unknown> | null): ActivityTrack | null {
  if (!body || body.version !== 1) return null;
  const { clientId, ownerId, startedAt, stoppedAt, segments } = body;
  if (typeof clientId !== "string" || !ACTIVITY_UUID.test(clientId) ||
      typeof ownerId !== "string" || ownerId.length < 1 || ownerId.length > 180 ||
      !bounded(startedAt, MIN_DATE, MAX_DATE) || !Number.isSafeInteger(startedAt) ||
      !bounded(stoppedAt, startedAt, startedAt + MAX_DURATION) || !Number.isSafeInteger(stoppedAt) ||
      !Array.isArray(segments) || segments.length < 1 || segments.length > ACTIVITY_MAX_POINTS) return null;
  let round: ActivityTrack["round"] = null;
  if (body.round != null) {
    const { key, generation } = body.round as Record<string, unknown>;
    if (!validActivityRoundKey(key) || typeof generation !== "string" || !/^[A-Za-z0-9:.+\-]{1,80}$/.test(generation)) return null;
    round = { key, generation };
  }
  let pointCount = 0;
  let lastAt = startedAt - 1;
  const checked = [];
  for (const segment of segments) {
    if (!Array.isArray(segment) || !segment.length) return null;
    const points: Point[] = [];
    for (const sample of segment) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) return null;
      const { at, lat, lng, accuracyM } = sample;
      if (++pointCount > ACTIVITY_MAX_POINTS || !bounded(at, lastAt + 1, stoppedAt) || !Number.isSafeInteger(at) ||
          !bounded(lat, -90, 90) || !bounded(lng, -180, 180) || !bounded(accuracyM, 0, 50)) return null;
      lastAt = at;
      points.push({ at, lat, lng, accuracyM });
    }
    checked.push(points);
  }
  return { version: 1, clientId, ownerId, startedAt, stoppedAt, round, segments: checked };
}

function meters(a: Point, b: Point): number {
  const r = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * r / 2);
  const y = Math.sin((b.lng - a.lng) * r / 2);
  const h = x * x + Math.cos(a.lat * r) * Math.cos(b.lat * r) * y * y;
  return 12_742_000 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}

export function activityTotals(track: ActivityTrack) {
  let distance = 0;
  let points = 0;
  for (const segment of track.segments) {
    let previous: Point | null = null;
    for (const point of segment) {
      points++;
      if (previous) {
        const elapsed = point.at - previous.at;
        const change = meters(previous, point);
        const threshold = Math.max(5, Math.min(20, Math.max(previous.accuracyM, point.accuracyM) / 2));
        if (elapsed <= MAX_GAP && change >= threshold && change <= 15 * elapsed / 1000) distance += change;
      }
      previous = point;
    }
  }
  return { distanceM: Math.round(distance), pointCount: points };
}

export function activityGpx(track: ActivityTrack): string {
  const timestamp = (at: number) => new Date(at).toISOString();
  const segments = track.segments.flatMap((segment) => {
    const output: string[] = [];
    let points: string[] = [];
    let previous: Point | null = null;
    for (const point of segment) {
      if (previous && point.at - previous.at > MAX_GAP) {
        output.push("<trkseg>" + points.join("") + "</trkseg>");
        points = [];
      }
      points.push(`<trkpt lat="${point.lat}" lon="${point.lng}"><time>${timestamp(point.at)}</time></trkpt>`);
      previous = point;
    }
    if (points.length) output.push("<trkseg>" + points.join("") + "</trkseg>");
    return output;
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="GVDG" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>GVDG round activity</name>' +
    segments.join("") + "</trk></gpx>\n";
}
