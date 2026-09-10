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
    winner: match.winner || null,
    score: match.score || "",
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

export function mergeRyderCupData(livePayload, sheetData) {
  const liveBoard = livePayload && livePayload.board ? livePayload.board : emptyBoard();
  const sheet = sheetData && typeof sheetData === "object"
    ? sheetData
    : { weeks: [], teamPoints: { red: 0, blue: 0 }, scoreboard: { red: { ...EMPTY_TEAM }, blue: { ...EMPTY_BLUE } } };
  const liveWeeks = Array.isArray(liveBoard.weeks) ? liveBoard.weeks : [];
  const sheetWeeks = Array.isArray(sheet.weeks) ? sheet.weeks : [];
  const liveByKey = new Map(liveWeeks.map((week) => [weekKey(week.label), week]));
  const order = [];
  const seen = new Set();
  function addLabel(label) {
    const key = weekKey(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    order.push(label);
  }
  for (const week of sheetWeeks) addLabel(week.label);
  for (const week of liveWeeks) addLabel(week.label);

  const weeks = order.map((label) => {
    const live = liveByKey.get(weekKey(label));
    const sheetWeek = sheetWeeks.find((week) => weekKey(week.label) === weekKey(label));
    if (live && Array.isArray(live.matches) && live.matches.length) {
      const liveNums = new Set(live.matches.map((match) => match.num));
      const fillIns = sheetWeek && Array.isArray(sheetWeek.matches)
        ? sheetWeek.matches.filter((match) => !liveNums.has(match.num)).map((match) => uiMatch(match, { official: false }))
        : [];
      return {
        label: live.label || label,
        dates: live.dates || (sheetWeek && sheetWeek.dates) || "",
        format: live.format || (sheetWeek && sheetWeek.format) || "singles",
        official: live.matches.some((match) => match.official),
        source: "live",
        matches: [...live.matches.map((match) => uiMatch(match, { official: !!match.official })), ...fillIns],
      };
    }
    if (sheetWeek) {
      return {
        label: sheetWeek.label || label,
        dates: sheetWeek.dates || "",
        format: sheetWeek.format || "singles",
        official: false,
        source: "sheet",
        matches: (sheetWeek.matches || []).map((match) => uiMatch(match, { official: false })),
      };
    }
    return {
      label,
      dates: "",
      format: "singles",
      official: false,
      source: "live",
      matches: [],
    };
  });

  const liveRed = liveBoard.scoreboard && liveBoard.scoreboard.red ? liveBoard.scoreboard.red : EMPTY_TEAM;
  const liveBlue = liveBoard.scoreboard && liveBoard.scoreboard.blue ? liveBoard.scoreboard.blue : EMPTY_BLUE;
  const sheetRed = sheet.scoreboard && sheet.scoreboard.red ? sheet.scoreboard.red : EMPTY_TEAM;
  const sheetBlue = sheet.scoreboard && sheet.scoreboard.blue ? sheet.scoreboard.blue : EMPTY_BLUE;
  const hasLivePoints = liveWeeks.some((week) => (week.matches || []).some((match) => match.official));

  return {
    scoreboard: {
      red: {
        name: liveRed.name || sheetRed.name || "Red Team",
        players: (liveRed.players && liveRed.players.length ? liveRed.players : sheetRed.players) || [],
      },
      blue: {
        name: liveBlue.name || sheetBlue.name || "Blue Team",
        players: (liveBlue.players && liveBlue.players.length ? liveBlue.players : sheetBlue.players) || [],
      },
    },
    teamPoints: liveBoard.teamPoints || { red: 0, blue: 0 },
    weeks,
    officialPoints: hasLivePoints,
    liveAvailable: !!(livePayload && livePayload.board),
    sheetAvailable: Array.isArray(sheet.weeks) && sheet.weeks.length > 0,
  };
}
