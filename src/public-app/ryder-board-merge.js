const EMPTY_TEAM = { name: "Red Team", players: [] };
const EMPTY_BLUE = { name: "Blue Team", players: [] };

function weekKey(label) {
  return String(label || "").trim().toLowerCase();
}

function namesFrom(match, side) {
  const playersKey = `${side}Players`;
  if (Array.isArray(match[playersKey]) && match[playersKey].length) {
    return match[playersKey].map((name) => String(name || "").trim()).filter(Boolean);
  }
  const value = match[side];
  if (Array.isArray(value)) return value.map((name) => String(name || "").trim()).filter(Boolean);
  const text = String(value || "").trim();
  return text ? [text] : [];
}

export function uiMatch(match, extras = {}) {
  const redPlayers = namesFrom(match, "red");
  const bluePlayers = namesFrom(match, "blue");
  return {
    num: match.num,
    winner: match.winner || extras.winner || null,
    score: match.score || extras.score || "",
    official: extras.official ?? !!match.official,
    livePath: match.livePath || extras.livePath || "",
    eventId: match.eventId || extras.eventId || null,
    status: match.status || extras.status || "",
    red: redPlayers[0] || "",
    blue: bluePlayers[0] || "",
    redPlayers,
    bluePlayers,
  };
}

function emptyBoard() {
  return {
    scoreboard: { red: { ...EMPTY_TEAM }, blue: { ...EMPTY_BLUE } },
    teamPoints: { red: 0, blue: 0 },
    weeks: [],
  };
}

function nameTokens(name) {
  return String(name || "").toLowerCase().split(/[^a-z]+/).filter((part) => part.length > 2);
}

function namesOverlap(left, right) {
  const a = new Set(nameTokens(left));
  const b = new Set(nameTokens(right));
  if (!a.size || !b.size) return false;
  for (const token of a) if (b.has(token)) return true;
  return false;
}

export function sidesOverlap(left, right) {
  const unused = [...right];
  let hits = 0;
  for (const name of left) {
    const index = unused.findIndex((other) => namesOverlap(name, other));
    if (index < 0) continue;
    unused.splice(index, 1);
    hits += 1;
  }
  const need = Math.min(left.length, right.length);
  return need > 0 && hits === need;
}

function scoreKey(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, "");
  if (!text) return "";
  if (text.startsWith("tie") || text === "as") return "tie";
  const margin = text.match(/(\d+&\d+)/);
  return margin ? margin[1] : text;
}

function scoresCompatible(sheetMatch, liveMatch) {
  const sheet = scoreKey(sheetMatch.score);
  const live = scoreKey(liveMatch.score);
  if (!sheet) return !live;
  if (!live) return true;
  return sheet === live;
}

function liveMatchFitsSheet(live, sheetMatch) {
  const liveRed = namesFrom(live, "red");
  const liveBlue = namesFrom(live, "blue");
  const sheetRed = namesFrom(sheetMatch, "red");
  const sheetBlue = namesFrom(sheetMatch, "blue");
  if (liveRed.length !== sheetRed.length || liveBlue.length !== sheetBlue.length) return false;
  return sidesOverlap(liveRed, sheetRed)
    && sidesOverlap(liveBlue, sheetBlue)
    && scoresCompatible(sheetMatch, live);
}

function liveIndexKey(weekLabel, num) {
  return weekKey(weekLabel) + "#" + String(num);
}

function flattenLiveMatches(liveWeeks) {
  const byWeekNum = new Map();
  const unlabeled = [];
  for (const week of liveWeeks) {
    for (const match of week.matches || []) {
      const labeled = weekKey(week.label).startsWith("week") || weekKey(week.label) === "finale";
      if (labeled && match.num) {
        byWeekNum.set(liveIndexKey(week.label, match.num), { week, match });
      } else {
        unlabeled.push({ week, match });
      }
    }
  }
  return { byWeekNum, unlabeled };
}

function attachLive(sheetMatch, live) {
  if (!live) return uiMatch(sheetMatch, { official: true });
  return uiMatch(sheetMatch, {
    official: true,
    livePath: live.livePath || live.match?.livePath,
    eventId: live.eventId || live.match?.eventId,
    status: live.status || live.match?.status,
  });
}

export function mergeRyderCupData(livePayload, sheetData) {
  const liveBoard = livePayload && livePayload.board ? livePayload.board : emptyBoard();
  const sheet = sheetData && typeof sheetData === "object"
    ? sheetData
    : { weeks: [], teamPoints: { red: 0, blue: 0 }, scoreboard: { red: { ...EMPTY_TEAM }, blue: { ...EMPTY_BLUE } } };
  const liveWeeks = Array.isArray(liveBoard.weeks) ? liveBoard.weeks : [];
  const sheetWeeks = Array.isArray(sheet.weeks) ? sheet.weeks : [];
  const { byWeekNum, unlabeled } = flattenLiveMatches(liveWeeks);
  const usedLive = new Set();

  function takeLiveFor(week, match) {
    const keyed = byWeekNum.get(liveIndexKey(week.label, match.num));
    if (keyed && !usedLive.has(keyed.match)) {
      usedLive.add(keyed.match);
      return keyed.match;
    }
    const found = unlabeled.find((row) => !usedLive.has(row.match) && liveMatchFitsSheet(row.match, match));
    if (found) {
      usedLive.add(found.match);
      return found.match;
    }
    return null;
  }

  const weeks = sheetWeeks.map((sheetWeek) => {
    const matches = (sheetWeek.matches || []).map((match) => attachLive(match, takeLiveFor(sheetWeek, match)));
    const played = matches.filter((match) => (match.score || "").length > 0 || !!match.winner).length;
    return {
      label: sheetWeek.label,
      dates: sheetWeek.dates || "",
      format: sheetWeek.format || "singles",
      official: true,
      source: "sheet",
      matches,
      played,
    };
  });

  for (const liveWeek of liveWeeks) {
    const leftover = (liveWeek.matches || []).filter((match) => !usedLive.has(match));
    if (!leftover.length) continue;
    const labeled = weekKey(liveWeek.label).startsWith("week") || weekKey(liveWeek.label) === "finale";
    if (labeled && weeks.some((week) => weekKey(week.label) === weekKey(liveWeek.label))) continue;
    weeks.push({
      label: liveWeek.label || "App-scored",
      dates: liveWeek.dates || "",
      format: liveWeek.format || "singles",
      official: false,
      source: "live",
      matches: leftover.map((match) => uiMatch(match, { official: false })),
    });
  }

  const sheetRed = sheet.scoreboard && sheet.scoreboard.red ? sheet.scoreboard.red : EMPTY_TEAM;
  const sheetBlue = sheet.scoreboard && sheet.scoreboard.blue ? sheet.scoreboard.blue : EMPTY_BLUE;
  const liveRed = liveBoard.scoreboard && liveBoard.scoreboard.red ? liveBoard.scoreboard.red : EMPTY_TEAM;
  const liveBlue = liveBoard.scoreboard && liveBoard.scoreboard.blue ? liveBoard.scoreboard.blue : EMPTY_BLUE;
  const sheetPoints = sheet.teamPoints && (sheet.teamPoints.red || sheet.teamPoints.blue || sheetWeeks.length)
    ? sheet.teamPoints
    : null;

  return {
    scoreboard: {
      red: {
        name: sheetRed.name || liveRed.name || "Red Team",
        players: (sheetRed.players && sheetRed.players.length ? sheetRed.players : liveRed.players) || [],
      },
      blue: {
        name: sheetBlue.name || liveBlue.name || "Blue Team",
        players: (sheetBlue.players && sheetBlue.players.length ? sheetBlue.players : liveBlue.players) || [],
      },
    },
    teamPoints: sheetPoints || liveBoard.teamPoints || { red: 0, blue: 0 },
    weeks,
    officialPoints: !!(sheetPoints && sheetWeeks.length),
    liveAvailable: !!(livePayload && livePayload.board),
    sheetAvailable: sheetWeeks.length > 0,
  };
}
