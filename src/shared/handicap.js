// Club handicap. Not UDisc's unpublished formula.
// A start is the number you begin a round with so an average day on this layout lands near even.
// Expected +4 over the last few rounds means start −4. Skilled average −6 means start +6.
// Net = start + this round's to-par.
// Only the newest 1–5 finished stroke rounds on that layout, inside the past year, count.
// One round counts half and two count three quarters, so a single wild card does not set the number.

export const HANDICAP_MAX_ROUNDS = 5;
export const HANDICAP_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const ALLOWANCE = { 1: 0.5, 2: 0.75 };

export function handicapScoringEnabled(config) {
  return Boolean(config && config.handicap === true && config.scoringStyle !== "matchplay" && config.scoringStyle !== "putting");
}

export function handicapKey(memberId) {
  const id = String(memberId || "").trim();
  if (!id || id.startsWith("g_") || id.startsWith("op_")) return "";
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < id.length; i++) {
    hash ^= BigInt(id.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function allowanceForRounds(count) {
  const n = Number(count) || 0;
  if (n <= 0) return 0;
  return ALLOWANCE[n] ?? 1;
}

export function handicapFromToPars(toPars) {
  const rows = (Array.isArray(toPars) ? toPars : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .slice(0, HANDICAP_MAX_ROUNDS);
  if (!rows.length) return null;
  const average = rows.reduce((sum, value) => sum + value, 0) / rows.length;
  const allowance = allowanceForRounds(rows.length);
  return {
    start: -Math.round(average * allowance),
    rounds: rows.length,
    provisional: rows.length < 3,
    average,
  };
}

function roundMemberId(row) {
  return row && (row.memberId || row.member_id) ? String(row.memberId || row.member_id) : "";
}

function roundToPar(row) {
  const value = row && (row.toPar != null ? row.toPar : row.to_par);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundPlayedAt(row) {
  return String((row && (row.playedAt || row.played_at || row.finalized_at || row.created_at)) || "");
}

export function handicapsFromRounds(rows, now = new Date()) {
  const cutoff = now.getTime() - HANDICAP_WINDOW_MS;
  const byKey = new Map();
  const sorted = (Array.isArray(rows) ? rows : []).slice().sort((left, right) => {
    return Date.parse(roundPlayedAt(right)) - Date.parse(roundPlayedAt(left));
  });
  for (const row of sorted) {
    const toPar = roundToPar(row);
    if (toPar == null) continue;
    const when = Date.parse(roundPlayedAt(row));
    if (!Number.isFinite(when) || when < cutoff) continue;
    const key = handicapKey(roundMemberId(row));
    if (!key) continue;
    const bucket = byKey.get(key) || { key, name: "", toPars: [] };
    if (bucket.toPars.length >= HANDICAP_MAX_ROUNDS) continue;
    const name = String((row && row.name) || "").trim();
    if (!bucket.name && name) bucket.name = name;
    bucket.toPars.push(toPar);
    byKey.set(key, bucket);
  }
  const players = [];
  for (const bucket of byKey.values()) {
    const handicap = handicapFromToPars(bucket.toPars);
    if (!handicap) continue;
    players.push({
      key: bucket.key,
      name: bucket.name,
      start: handicap.start,
      rounds: handicap.rounds,
      provisional: handicap.provisional,
    });
  }
  players.sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  return players;
}

export function myLayoutHandicaps(casual, now = new Date()) {
  const byLayout = new Map();
  for (const row of Array.isArray(casual) ? casual : []) {
    if (!row || row.stroke === false || row.stroke === 0 || row.stroke_singles === 0) continue;
    if (row.place == null || row.place === "") continue;
    const toPar = Number(row.to_par);
    if (!Number.isFinite(toPar)) continue;
    const layoutId = Number(row.layout_id);
    if (!Number.isInteger(layoutId) || layoutId <= 0) continue;
    const bucket = byLayout.get(layoutId) || {
      layoutId,
      course: "",
      layout: "",
      rounds: [],
    };
    const course = String(row.course_name || "").trim();
    const layout = String(row.layout_name || "").trim();
    if (!bucket.course && course) bucket.course = course;
    if (!bucket.layout && layout) bucket.layout = layout;
    bucket.rounds.push({
      memberId: "self",
      name: "You",
      toPar,
      playedAt: row.finalized_at || row.event_date || row.created_at || "",
    });
    byLayout.set(layoutId, bucket);
  }
  const out = [];
  for (const bucket of byLayout.values()) {
    const mine = handicapsFromRounds(bucket.rounds, now)[0];
    if (!mine) continue;
    out.push({
      layoutId: bucket.layoutId,
      course: bucket.course || "Course",
      layout: bucket.layout,
      start: mine.start,
      rounds: mine.rounds,
      provisional: mine.provisional,
    });
  }
  out.sort((left, right) => left.course.localeCompare(right.course) || left.layout.localeCompare(right.layout));
  return out;
}

function applyOne(standing, byKey) {
  const keys = Array.isArray(standing && standing.handicapKeys) ? standing.handicapKeys : [];
  if (!keys.length || keys.some((key) => !key || !byKey[key] || !Number.isFinite(Number(byKey[key].start)))) {
    return { handicapStart: null, net: null, provisional: false, handicapRounds: 0 };
  }
  let start = 0;
  let rounds = Infinity;
  let provisional = false;
  for (const key of keys) {
    const row = byKey[key];
    start += Number(row.start);
    rounds = Math.min(rounds, Number(row.rounds) || 0);
    if (row.provisional) provisional = true;
  }
  const teamStart = keys.length > 1 ? Math.round(start / keys.length) : start;
  const toPar = Number(standing.toPar);
  const gross = Number.isFinite(toPar) ? toPar : 0;
  return { handicapStart: teamStart, net: teamStart + gross, provisional, handicapRounds: Number.isFinite(rounds) ? rounds : 0 };
}

export function decorateStandings(standings, byKey) {
  const rows = Array.isArray(standings) ? standings : [];
  if (!byKey || typeof byKey !== "object") return rows.slice();
  const decorated = rows.map((standing, index) => ({ ...standing, ...applyOne(standing, byKey), _order: index }));
  if (!decorated.some((standing) => standing.handicapStart != null)) return rows.slice();
  decorated.sort((left, right) => {
    const leftOn = left.handicapStart != null;
    const rightOn = right.handicapStart != null;
    if (leftOn !== rightOn) return leftOn ? -1 : 1;
    if (leftOn && left.net !== right.net) return left.net - right.net;
    const leftPar = Number(left.toPar) || 0;
    const rightPar = Number(right.toPar) || 0;
    if (leftPar !== rightPar) return leftPar - rightPar;
    return left._order - right._order;
  });
  return decorated.map((standing) => {
    const next = { ...standing };
    delete next._order;
    return next;
  });
}
