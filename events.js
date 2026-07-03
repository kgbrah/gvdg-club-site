// events.js — pure, DOM-free helpers for the GVDG public events hub.
//
// No DOM, no network access here so it can run headless under `node --test`.
// All rendering + fetching lives in events.html. These functions normalize the
// club Worker's REST payloads, bucket events into Live / Upcoming / Past, sort
// each bucket, group a roster by division, and format ISO dates defensively.
//
// Public API: VALID_STATUSES, VALID_TYPES, normalizeEvent, bucketEvents,
// groupPlayersByDivision, formatEventDate, typeLabel, statusLabel, courseNameFor.

export const VALID_STATUSES = ['scheduled', 'live', 'final', 'cancelled'];
export const VALID_TYPES = ['tournament', 'league_round', 'fundraiser', 'meeting'];

// Human labels for the enum values the API returns. Anything unrecognized is
// passed through verbatim (still XSS-safe — it only ever lands in textContent).
const TYPE_LABELS = {
  tournament: 'Tournament',
  league_round: 'League Round',
  fundraiser: 'Fundraiser',
  meeting: 'Meeting',
};
const STATUS_LABELS = {
  scheduled: 'Scheduled',
  live: 'Live',
  final: 'Final',
  cancelled: 'Cancelled',
};
const SCORING_FORMAT_LABELS = {
  stroke: 'Stroke play',
  matchplay: 'Matchplay',
};
const PLAY_FORMAT_LABELS = {
  singles: 'Singles',
  doubles: 'Doubles',
  teams: 'Teams',
};

export function typeLabel(type) {
  if (type == null) return 'Event';
  return TYPE_LABELS[type] || String(type);
}

export function statusLabel(status) {
  if (status == null) return '';
  return STATUS_LABELS[status] || String(status);
}

// Parse an event's date defensively. The API may send a full ISO timestamp, a
// bare YYYY-MM-DD, null, or junk. Returns a Date or null (never throws).
export function parseEventDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// Format a date for display. Tolerates ISO strings, Date objects and nulls.
// Bare YYYY-MM-DD values are rendered without a time (so a date-only event
// doesn't show a spurious "12:00 AM" from the local-midnight parse).
export function formatEventDate(raw) {
  const d = parseEventDate(raw);
  if (!d) return 'Date TBD';
  const dateOnly = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
  const opts = dateOnly
    ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return d.toLocaleString([], opts);
  } catch (_e) {
    return d.toDateString();
  }
}

// Normalize one raw API event into a predictable shape with safe defaults.
// Unknown status/type values are preserved (rendered verbatim) but the bucketer
// treats unknown statuses as "upcoming-ish" so nothing silently vanishes.
export function normalizeEvent(raw) {
  const ev = raw && typeof raw === 'object' ? raw : {};
  const playFormat = ev.playFormat != null ? String(ev.playFormat) : ev.play_format != null ? String(ev.play_format) : '';
  return {
    id: ev.id != null ? String(ev.id) : '',
    type: ev.type != null ? String(ev.type) : '',
    name: ev.name != null ? String(ev.name) : 'Untitled Event',
    status: ev.status != null ? String(ev.status) : 'scheduled',
    format: ev.format != null ? String(ev.format) : '',
    play_format: playFormat,
    playFormat,
    teamRequired: ev.teamRequired === true || ev.team_required === true,
    date: ev.date != null ? String(ev.date) : null,
    course_id: ev.course_id != null ? String(ev.course_id) : '',
    layout_id: ev.layout_id != null ? String(ev.layout_id) : '', // selected scoring layout (T4 tee-sign render)
    league_id: ev.league_id != null ? String(ev.league_id) : '',
    source: ev.source != null ? String(ev.source) : '',
    external_url: ev.external_url != null ? String(ev.external_url) : '',
    notes: ev.notes != null ? String(ev.notes) : '',
    // Detail payloads carry a players array; hub payloads don't.
    players: Array.isArray(ev.players) ? ev.players : [],
    _date: parseEventDate(ev.date),
  };
}

function cleanString(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

function formatToken(value) {
  return cleanString(value).toLowerCase();
}

function labelFromToken(labels, token) {
  if (!token) return '';
  if (labels[token]) return labels[token];
  return token
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function scoringFormatKey(format) {
  const token = formatToken(format);
  return token === 'doubles' || token === 'teams' ? 'stroke' : token;
}

function playFormatKey(playFormat, format) {
  const explicit = formatToken(playFormat);
  if (explicit) return explicit;
  const legacy = formatToken(format);
  return legacy === 'singles' || legacy === 'doubles' || legacy === 'teams' ? legacy : '';
}

export function roundFormatLabel(raw) {
  const ev = raw && typeof raw === 'object' ? raw : {};
  const play = labelFromToken(PLAY_FORMAT_LABELS, playFormatKey(ev.playFormat ?? ev.play_format, ev.format));
  const scoring = labelFromToken(SCORING_FORMAT_LABELS, scoringFormatKey(ev.format));
  return [play, scoring].filter(Boolean).join(' · ');
}

export function isTeamRound(raw) {
  const ev = raw && typeof raw === 'object' ? raw : {};
  const play = playFormatKey(ev.playFormat ?? ev.play_format, ev.format);
  return ev.teamRequired === true || ev.team_required === true || play === 'doubles' || play === 'teams';
}

// Bucket a list of raw events into { live, upcoming, past, cancelled }.
//   - live      : status === 'live'                       (highlighted in UI)
//   - upcoming  : status === 'scheduled' (or unknown)     (soonest first)
//   - past      : status === 'final'                      (most recent first)
//   - cancelled : status === 'cancelled'                  (kept out of the way)
// Events with no parseable date sort to the end of their bucket.
export function bucketEvents(rawEvents) {
  const list = Array.isArray(rawEvents) ? rawEvents.map(normalizeEvent) : [];
  const live = [];
  const upcoming = [];
  const past = [];
  const cancelled = [];

  for (const ev of list) {
    if (ev.status === 'live') live.push(ev);
    else if (ev.status === 'final') past.push(ev);
    else if (ev.status === 'cancelled') cancelled.push(ev);
    else upcoming.push(ev); // 'scheduled' + any unrecognized status
  }

  // Soonest-first; missing dates last.
  const ascending = (a, b) => dateRank(a, +1) - dateRank(b, +1);
  // Most-recent-first; missing dates last.
  const descending = (a, b) => dateRank(b, -1) - dateRank(a, -1);

  upcoming.sort(ascending);
  live.sort(ascending);
  past.sort(descending);
  cancelled.sort(descending);

  return { live, upcoming, past, cancelled };
}

// Sort key that always pushes date-less events to the end of their bucket,
// regardless of sort direction. `dir` is +1 for ascending, -1 for descending.
function dateRank(ev, dir) {
  if (!ev._date) return dir === +1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return ev._date.getTime();
}

// Group an event's player roster by division, preserving first-seen order of
// both divisions and players. Players with no division fall under 'Open'.
// Returns an array of { division, players: [...] } so the caller can render
// stable, ordered sections. Non-array input yields [].
export function groupPlayersByDivision(players) {
  if (!Array.isArray(players)) return [];
  const order = [];
  const byDivision = new Map();
  for (const p of players) {
    const player = p && typeof p === 'object' ? p : {};
    const division = (player.division != null && String(player.division).trim()) || 'Open';
    if (!byDivision.has(division)) {
      byDivision.set(division, []);
      order.push(division);
    }
    byDivision.get(division).push(player);
  }
  return order.map((division) => ({ division, players: byDivision.get(division) }));
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function playerScore(player, hole) {
  const scores = recordValue(player.scores);
  return finiteNumber(scores[hole]) ?? finiteNumber(scores[String(hole)]);
}

function singleStandings(snap) {
  const standings = Array.isArray(snap.standings) ? snap.standings : [];
  return standings.map((raw) => {
    const row = recordValue(raw);
    return {
      name: cleanString(row.name) || 'Player',
      division: cleanString(row.division) || null,
      thru: finiteNumber(row.thru) ?? 0,
      total: finiteNumber(row.total) ?? 0,
      toPar: finiteNumber(row.toPar) ?? 0,
      playersText: '',
      teamRow: false,
    };
  });
}

function teamDivision(players) {
  const divisions = players.map((player) => cleanString(recordValue(player).division)).filter(Boolean);
  return divisions.length && divisions.every((division) => division === divisions[0]) ? divisions[0] : null;
}

function teamStanding(name, players, holes) {
  let thru = 0;
  let total = 0;
  let toPar = 0;
  for (const rawHole of holes) {
    const hole = recordValue(rawHole);
    const holeNo = finiteNumber(hole.hole);
    const par = finiteNumber(hole.par);
    if (holeNo == null) continue;
    let strokes = null;
    for (const rawPlayer of players) {
      strokes = playerScore(recordValue(rawPlayer), holeNo);
      if (strokes != null) break;
    }
    if (strokes == null) continue;
    thru++;
    total += strokes;
    if (par != null) toPar += strokes - par;
  }
  return {
    name,
    division: teamDivision(players),
    thru,
    total,
    toPar,
    playersText: players.map((player) => cleanString(recordValue(player).name)).filter(Boolean).join(' / '),
    teamRow: true,
  };
}

export function liveStandingsForDisplay(rawSnap) {
  const snap = recordValue(rawSnap);
  if (!isTeamRound(snap)) return singleStandings(snap);
  const players = Array.isArray(snap.players) ? snap.players : [];
  const holes = Array.isArray(snap.holes) ? snap.holes : [];
  if (!players.length || !holes.length) return singleStandings(snap);

  const byTeam = new Map();
  for (const rawPlayer of players) {
    const player = recordValue(rawPlayer);
    const team = cleanString(player.team) || cleanString(player.name) || 'Team';
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(player);
  }

  const rows = [...byTeam.entries()].map(([team, teamPlayers]) => teamStanding(team, teamPlayers, holes));
  rows.sort((a, b) => a.toPar - b.toPar || a.total - b.total || a.name.localeCompare(b.name));
  return rows.length ? rows : singleStandings(snap);
}

// Build a course_id -> course-name lookup from the /courses payload, then a
// resolver. Falls back to a friendly placeholder when the id is unknown/blank.
export function buildCourseIndex(rawCourses) {
  const index = new Map();
  if (Array.isArray(rawCourses)) {
    for (const c of rawCourses) {
      if (c && c.id != null) index.set(String(c.id), c);
    }
  }
  return index;
}

export function courseNameFor(courseIndex, courseId) {
  if (!courseId) return '';
  const course = courseIndex instanceof Map ? courseIndex.get(String(courseId)) : null;
  return course && course.name ? String(course.name) : '';
}
