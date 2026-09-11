const EASTERN = "America/New_York";

export function easternYear(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, year: "numeric" }).formatToParts(now);
  return Number(parts.find((part) => part.type === "year")?.value) || now.getFullYear();
}

export function easternDateOnly(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: EASTERN }).format(now);
}

export function dateYear(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})/);
  if (match) return Number(match[1]);
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
}

export function namesMatch(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  return Boolean(a && b && a === b);
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inYear(value, year) {
  return dateYear(value) === year;
}

function seasonRounds(ratings, year) {
  const competitive = Array.isArray(ratings?.competitive?.rounds) ? ratings.competitive.rounds : [];
  const casual = Array.isArray(ratings?.casual?.rounds) ? ratings.casual.rounds : [];
  return competitive.concat(casual).filter((round) => inYear(round.date, year));
}

function upcomingRegistrations(registrations, today) {
  return (Array.isArray(registrations) ? registrations : []).filter((row) => {
    const status = String(row.event_status || "").toLowerCase();
    if (status === "final" || status === "cancelled") return false;
    const date = String(row.event_date || "").slice(0, 10);
    return !date || date >= today;
  });
}

function playerStandings(leagues, memberName) {
  return (Array.isArray(leagues) ? leagues : []).map((item) => {
    const players = Array.isArray(item.standings) ? item.standings : [];
    const index = players.findIndex((player) => namesMatch(player.name, memberName));
    if (index < 0) return null;
    const player = players[index];
    const league = item.league || {};
    return {
      leagueId: league.id ?? null,
      leagueName: league.name || "League",
      season: league.season || null,
      officialSheet: item.officialSheet === true,
      place: index + 1,
      points: numberOrNull(player.points),
      events: numberOrNull(player.events),
      wins: numberOrNull(player.wins),
      field: players.length,
    };
  }).filter(Boolean);
}

export function buildSeasonPage({
  results = [],
  ratings = null,
  registrations = [],
  leagues = [],
  memberName = "",
  now = new Date(),
} = {}) {
  const year = easternYear(now);
  const today = easternDateOnly(now);
  const seasonResults = (Array.isArray(results) ? results : []).filter((row) => inYear(row.event_date || row.created_at, year));
  const stroke = seasonResults
    .map((row) => numberOrNull(row.to_par))
    .filter((value) => value != null);
  const places = seasonResults
    .map((row) => numberOrNull(row.place))
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  const rated = seasonRounds(ratings, year).filter((round) => numberOrNull(round.rating) != null);
  const ratingValues = rated.map((round) => numberOrNull(round.rating)).filter((value) => value != null);

  return {
    year,
    rounds: seasonResults.length,
    avgToPar: stroke.length
      ? Math.round((stroke.reduce((sum, value) => sum + value, 0) / stroke.length) * 10) / 10
      : null,
    bestFinish: places[0] ?? null,
    clubRating: ratingValues.length
      ? Math.round(ratingValues.reduce((sum, value) => sum + value, 0) / ratingValues.length)
      : null,
    ratedRounds: rated.length,
    results: seasonResults,
    upcoming: upcomingRegistrations(registrations, today),
    standings: playerStandings(leagues, memberName),
  };
}
