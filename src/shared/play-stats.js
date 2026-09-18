import { holePoint, puttingCircle, remainingFt } from "./hole-map-model.js";

export const PARKED_FT = 10;
export const FAIRWAY_WIDTH_FT = 45;

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toXY(point, origin) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(origin.lat * Math.PI / 180);
  return {
    x: (point.lng - origin.lng) * mPerDegLng * 3.28084,
    y: (point.lat - origin.lat) * mPerDegLat * 3.28084,
  };
}

export function lineOffsetFt(point, a, b) {
  const p = holePoint(point);
  const start = holePoint(a);
  const end = holePoint(b);
  if (!p || !start || !end) return null;
  const A = toXY(start, start);
  const B = toXY(end, start);
  const P = toXY(p, start);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return remainingFt(p, start);
  let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Math.round(Math.hypot(P.x - (A.x + t * abx), P.y - (A.y + t * aby)));
}

export function fairwayHit(drive, tee, target) {
  const offset = lineOffsetFt(drive, tee, target);
  if (offset == null) return null;
  return offset <= FAIRWAY_WIDTH_FT;
}

export function regulationStrokes(par) {
  const n = Number(par);
  if (!Number.isFinite(n) || n < 2) return 1;
  return Math.max(1, Math.round(n) - 2);
}

function sample(hit, att) {
  if (!att) return null;
  return { att, hit: hit ? 1 : 0 };
}

export function holePlayStats(hole, throws, score) {
  const rows = Array.isArray(throws) ? throws : [];
  const strokes = Number(score);
  const scored = Number.isInteger(strokes) && strokes > 0;
  const tee = holePoint(hole && hole.tee);
  const basket = holePoint(hole && (hole.target || hole.basket));
  const par = Number(hole && hole.par);
  const stats = {
    fir: null,
    c1r: null,
    c2r: null,
    parked: null,
    scramble: null,
    c1Putt: { att: 0, hit: 0 },
    c2Putt: { att: 0, hit: 0 },
  };

  if (rows[0] && tee && basket) {
    const hit = fairwayHit(rows[0], tee, basket);
    if (hit != null) stats.fir = sample(hit, 1);
  }

  const reg = regulationStrokes(par);
  if (rows.length >= reg && basket) {
    const lie = rows[reg - 1];
    const circle = puttingCircle(lie, basket);
    const rem = remainingFt(lie, basket);
    stats.c1r = sample(circle === "C1", 1);
    stats.c2r = sample(circle === "C1" || circle === "C2", 1);
    stats.parked = sample(rem != null && rem <= PARKED_FT, 1);
  }

  if (scored && Number.isFinite(par) && stats.c1r && stats.c1r.hit === 0) {
    stats.scramble = sample(strokes <= par, 1);
  }

  if (basket && scored) {
    for (let i = 0; i < rows.length; i += 1) {
      const circle = puttingCircle(rows[i], basket);
      if (circle !== "C1" && circle !== "C2") continue;
      const made = i === rows.length - 1 && strokes === i + 2;
      const bucket = circle === "C1" ? "c1Putt" : "c2Putt";
      stats[bucket].att += 1;
      if (made) stats[bucket].hit += 1;
    }
  }

  if (!stats.c1Putt.att) stats.c1Putt = null;
  if (!stats.c2Putt.att) stats.c2Putt = null;
  return stats;
}

export function emptyPlayTotals() {
  return {
    holes: 0,
    eagles: 0,
    birdies: 0,
    pars: 0,
    bogeys: 0,
    doubles_plus: 0,
    birdie_hit: 0,
    par_hit: 0,
    fir_hit: 0,
    fir_att: 0,
    c1r_hit: 0,
    c1r_att: 0,
    c2r_hit: 0,
    c2r_att: 0,
    parked_hit: 0,
    parked_att: 0,
    scramble_hit: 0,
    scramble_att: 0,
    c1_putt_hit: 0,
    c1_putt_att: 0,
    c2_putt_hit: 0,
    c2_putt_att: 0,
  };
}

function applyScoreMix(totals, par, strokes) {
  if (!Number.isInteger(strokes) || strokes <= 0 || !Number.isFinite(par)) return;
  totals.holes += 1;
  const delta = strokes - par;
  if (delta <= -2) totals.eagles += 1;
  else if (delta === -1) totals.birdies += 1;
  else if (delta === 0) totals.pars += 1;
  else if (delta === 1) totals.bogeys += 1;
  else totals.doubles_plus += 1;
  if (delta <= -1) totals.birdie_hit += 1;
  if (delta <= 0) totals.par_hit += 1;
}

function addSample(totals, sampleValue, hitKey, attKey) {
  if (!sampleValue) return;
  totals[hitKey] += num(sampleValue.hit);
  totals[attKey] += num(sampleValue.att);
}

export function addHoleToTotals(totals, hole, throws, score) {
  applyScoreMix(totals, Number(hole && hole.par), Number(score));
  const stats = holePlayStats(hole, throws, score);
  addSample(totals, stats.fir, "fir_hit", "fir_att");
  addSample(totals, stats.c1r, "c1r_hit", "c1r_att");
  addSample(totals, stats.c2r, "c2r_hit", "c2r_att");
  addSample(totals, stats.parked, "parked_hit", "parked_att");
  addSample(totals, stats.scramble, "scramble_hit", "scramble_att");
  addSample(totals, stats.c1Putt, "c1_putt_hit", "c1_putt_att");
  addSample(totals, stats.c2Putt, "c2_putt_hit", "c2_putt_att");
  return totals;
}

export function totalsFromHoleScores(pars, scores) {
  const totals = emptyPlayTotals();
  const n = Math.min(
    Array.isArray(pars) ? pars.length : 0,
    Array.isArray(scores) ? scores.length : 0,
  );
  for (let i = 0; i < n; i += 1) applyScoreMix(totals, Number(pars[i]), Number(scores[i]));
  return totals;
}

export function parseScoreCsv(raw, limit) {
  const values = String(raw || "").split(",");
  const out = [];
  for (const value of values) {
    const n = Number(String(value).trim());
    if (!Number.isInteger(n) || n <= 0) {
      if (out.length) break;
      continue;
    }
    out.push(n);
    if (limit && out.length >= limit) break;
  }
  return out;
}

export function totalsFromPdgaScoreLine(scoresRaw, parsRaw, holes) {
  const scores = parseScoreCsv(scoresRaw);
  const pars = parseScoreCsv(parsRaw);
  const n = Math.min(Number(holes) || 18, scores.length, pars.length);
  return totalsFromHoleScores(pars.slice(0, n), scores.slice(0, n));
}

export function mergePartnerPlayInputs(players) {
  const scores = {};
  const throwsByHole = {};
  for (const player of Array.isArray(players) ? players : []) {
    if (!player) continue;
    for (const [hole, score] of Object.entries(player.scores || {})) {
      const n = Number(hole);
      if (scores[n] == null && Number.isFinite(Number(score)) && Number(score) > 0) scores[n] = Number(score);
    }
    for (const [hole, marks] of Object.entries(player.throws || {})) {
      const n = Number(hole);
      if (throwsByHole[n] == null && Array.isArray(marks) && marks.length) throwsByHole[n] = marks;
    }
  }
  return { scores, throws: throwsByHole };
}

export function partnersForStanding(standing, players) {
  const group = standing && standing.scoringGroup;
  const list = Array.isArray(players) ? players : [];
  if (group && group.targetType === "pair" && Array.isArray(group.members) && group.members.length) {
    const names = new Set(group.members.map((name) => String(name)));
    const partners = list.filter((player) => player && !player.removed && names.has(player.name));
    if (partners.length) return partners;
  }
  const one = list.find((row) => (
    (standing && standing.memberId && row.memberId === standing.memberId) ||
    (standing && row.name === standing.name)
  ));
  return one ? [one] : [];
}


export function roundPlayStats(holes, throwsByHole, scores) {
  const totals = emptyPlayTotals();
  for (const hole of Array.isArray(holes) ? holes : []) {
    const n = hole && hole.hole;
    addHoleToTotals(
      totals,
      hole,
      throwsByHole && (throwsByHole[n] || throwsByHole[String(n)]),
      scores && (scores[n] || scores[String(n)]),
    );
  }
  return totals;
}

export function parseBreakdown(raw) {
  const totals = emptyPlayTotals();
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return totals; }
  }
  if (!obj || typeof obj !== "object") return totals;
  const eagles = num(obj.eagles);
  const birdies = num(obj.birdies);
  const pars = num(obj.pars);
  const bogeys = num(obj.bogeys);
  const doubles = num(obj.doubles_plus);
  totals.eagles = eagles;
  totals.birdies = birdies;
  totals.pars = pars;
  totals.bogeys = bogeys;
  totals.doubles_plus = doubles;
  totals.holes = num(obj.holes) || eagles + birdies + pars + bogeys + doubles;
  totals.birdie_hit = num(obj.birdie_hit) || (eagles + birdies);
  totals.par_hit = num(obj.par_hit) || (eagles + birdies + pars);
  totals.fir_hit = num(obj.fir_hit);
  totals.fir_att = num(obj.fir_att);
  totals.c1r_hit = num(obj.c1r_hit);
  totals.c1r_att = num(obj.c1r_att);
  totals.c2r_hit = num(obj.c2r_hit);
  totals.c2r_att = num(obj.c2r_att);
  totals.parked_hit = num(obj.parked_hit);
  totals.parked_att = num(obj.parked_att);
  totals.scramble_hit = num(obj.scramble_hit);
  totals.scramble_att = num(obj.scramble_att);
  totals.c1_putt_hit = num(obj.c1_putt_hit);
  totals.c1_putt_att = num(obj.c1_putt_att);
  totals.c2_putt_hit = num(obj.c2_putt_hit);
  totals.c2_putt_att = num(obj.c2_putt_att);
  return totals;
}

export function sumPlayTotals(rows) {
  const totals = emptyPlayTotals();
  for (const row of Array.isArray(rows) ? rows : []) {
    const parsed = parseBreakdown(row && (row.breakdown != null ? row.breakdown : row));
    for (const key of Object.keys(totals)) totals[key] += parsed[key] || 0;
  }
  return totals;
}

export const PLAY_CATEGORIES = [
  { att: "holes", group: "mix", hit: "eagles", id: "eagle", invert: false, label: "Eagle+", min: 18, short: "Eagle", tone: "eagle" },
  { att: "holes", group: "mix", hit: "birdies", id: "birdieMix", invert: false, label: "Birdie", min: 18, short: "Birdie", tone: "birdie" },
  { att: "holes", group: "mix", hit: "pars", id: "parMix", invert: false, label: "Par", min: 18, short: "Par", tone: "par" },
  { att: "holes", group: "mix", hit: "bogeys", id: "bogey", invert: true, label: "Bogey", min: 18, short: "Bogey", tone: "bogey" },
  { att: "holes", group: "mix", hit: "doubles_plus", id: "double", invert: true, label: "Double+", min: 18, short: "Dbl+", tone: "double" },
  { att: "holes", group: "score", hit: "birdie_hit", id: "birdie", invert: false, label: "Birdie+", min: 18, short: "Birdie+", tone: "birdie" },
  { att: "holes", group: "score", hit: "par_hit", id: "par", invert: false, label: "Par+", min: 18, short: "Par+", tone: "par" },
  { att: "fir_att", group: "throw", hit: "fir_hit", id: "fir", invert: false, label: "Fairways", min: 9, short: "FIR", tone: null },
  { att: "c1r_att", group: "throw", hit: "c1r_hit", id: "c1r", invert: false, label: "C1 in reg", min: 9, short: "C1R", tone: null },
  { att: "c2r_att", group: "throw", hit: "c2r_hit", id: "c2r", invert: false, label: "C2 in reg", min: 9, short: "C2R", tone: null },
  { att: "c1_putt_att", group: "throw", hit: "c1_putt_hit", id: "c1Putt", invert: false, label: "C1 putting", min: 8, short: "C1 putt", tone: null },
  { att: "c2_putt_att", group: "throw", hit: "c2_putt_hit", id: "c2Putt", invert: false, label: "C2 putting", min: 5, short: "C2 putt", tone: null },
  { att: "parked_att", group: "throw", hit: "parked_hit", id: "parked", invert: false, label: "Parked", min: 6, short: "Parked", tone: null },
  { att: "scramble_att", group: "throw", hit: "scramble_hit", id: "scramble", invert: false, label: "Scramble", min: 5, short: "Scramble", tone: null },
];

export const SCORE_MIX_IDS = PLAY_CATEGORIES.filter((row) => row.group === "mix").map((row) => row.id);
export const COMPACT_STAT_IDS = ["birdie", "par", "fir", "c1Putt"];

export function statPct(hit, att) {
  if (!att) return null;
  return Math.round((1000 * hit) / att) / 10;
}

export function formatPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return (Math.round(pct * 10) / 10).toFixed(pct % 1 ? 1 : 0) + "%";
}

export function formatRank(rank, field) {
  if (rank == null || !field) return "Unranked";
  return "#" + rank + " of " + field;
}

export function formatRankNeed(mine, min, field) {
  if (mine && mine.rank != null) return formatRank(mine.rank, mine.field || field);
  if (mine && mine.att) return "Need " + min + " to rank";
  if (field) return "Need " + min + " to rank";
  return "No club sample yet";
}

function playerSample(player, category) {
  if (!player) return null;
  const totals = player.totals || player;
  const hit = num(totals[category.hit]);
  const att = num(totals[category.att]);
  return {
    att,
    hit,
    memberId: player.memberId || player.member_id || null,
    name: player.name || "Player",
    pct: statPct(hit, att),
  };
}

export function rankCategory(players, category) {
  const eligible = [];
  for (const player of Array.isArray(players) ? players : []) {
    const totals = player.totals || player;
    const hit = num(totals[category.hit]);
    const att = num(totals[category.att]);
    if (att < category.min) continue;
    eligible.push({
      att,
      hit,
      memberId: player.memberId || player.member_id || null,
      name: player.name || "Player",
      pct: statPct(hit, att),
    });
  }
  const dir = category.invert ? 1 : -1;
  eligible.sort((a, b) => (dir * ((a.pct ?? 0) - (b.pct ?? 0))) || (b.att - a.att) || String(a.name).localeCompare(String(b.name)));
  return eligible.map((row, index) => ({ ...row, field: eligible.length, rank: index + 1 }));
}

export function playStatsView(players, memberId) {
  const me = (Array.isArray(players) ? players : []).find((player) => player.memberId && player.memberId === memberId) || null;
  return PLAY_CATEGORIES.map((category) => {
    const ranked = rankCategory(players, category);
    const rankedMine = ranked.find((row) => row.memberId && row.memberId === memberId) || null;
    const sampleRow = playerSample(me, category);
    const mine = rankedMine || (sampleRow && sampleRow.att
      ? { ...sampleRow, field: ranked.length, rank: null }
      : null);
    return {
      field: ranked.length,
      group: category.group,
      id: category.id,
      invert: !!category.invert,
      label: category.label,
      leaders: ranked.slice(0, 5),
      mine,
      min: category.min,
      short: category.short || category.label,
      tone: category.tone || null,
    };
  });
}

export const PLAY_KINDS = ["competitive", "casual", "pdga"];
export const PLAY_GROUPS = ["all", "singles", "doubles"];
export const PLAY_STYLES = ["all", "stroke", "matchplay"];

export function playRowKind(row) {
  const kind = String(row && row.kind || "").toLowerCase();
  if (kind === "casual") return "casual";
  if (kind === "pdga") return "pdga";
  return "competitive";
}

export function playKindLabel(kind) {
  if (kind === "casual") return "Casual";
  if (kind === "pdga") return "PDGA";
  return "Competitive";
}

export function playRowGroup(row) {
  return String(row && (row.groupFormat || row.group_format) || "").toLowerCase() === "doubles" ? "doubles" : "singles";
}

export function playRowStyle(row) {
  return String(row && (row.scoringStyle || row.scoring_style) || "").toLowerCase() === "matchplay" ? "matchplay" : "stroke";
}

export function playGroupLabel(group) {
  if (group === "doubles") return "Doubles";
  if (group === "singles") return "Singles";
  return "All";
}

export function playStyleLabel(style) {
  if (style === "matchplay") return "Match play";
  if (style === "stroke") return "Stroke";
  return "All";
}

export function playViewKey(group, style) {
  const g = group === "doubles" || group === "singles" ? group : "all";
  const s = style === "matchplay" || style === "stroke" ? style : "all";
  return g + "-" + s;
}

export function playersFromRows(rows) {
  const byMember = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = raw || {};
    const memberId = String(row.memberId || row.member_id || "");
    if (!memberId) continue;
    const current = byMember.get(memberId) || { breakdowns: [], memberId, name: String(row.name || "Player") };
    if (row.name) current.name = String(row.name);
    current.breakdowns.push(row.breakdown != null ? row.breakdown : row);
    byMember.set(memberId, current);
  }
  return [...byMember.values()].map((player) => ({
    memberId: player.memberId,
    name: player.name,
    totals: sumPlayTotals(player.breakdowns.map((breakdown) => ({ breakdown }))),
  }));
}

export function playStatsBucket(rows, memberId) {
  const players = playersFromRows(rows);
  const me = players.find((player) => player.memberId === memberId);
  return {
    categories: playStatsView(players, memberId),
    mine: me
      ? { memberId: me.memberId, name: me.name, totals: me.totals }
      : { memberId: memberId || "", name: "", totals: emptyPlayTotals() },
  };
}

export function playStatsKindPayload(rows, memberId) {
  const views = {};
  for (const group of PLAY_GROUPS) {
    for (const style of PLAY_STYLES) {
      const filtered = (Array.isArray(rows) ? rows : []).filter((row) => (
        (group === "all" || playRowGroup(row) === group) &&
        (style === "all" || playRowStyle(row) === style)
      ));
      views[playViewKey(group, style)] = playStatsBucket(filtered, memberId);
    }
  }
  return { ...views[playViewKey("all", "all")], views };
}

export function selectPlayStatsView(kindPayload, group, style) {
  if (!kindPayload) return null;
  const key = playViewKey(group, style);
  return (kindPayload.views && kindPayload.views[key]) || kindPayload;
}

export function playStatsByKind(rows, memberId) {
  const competitive = [];
  const casual = [];
  const pdga = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const kind = playRowKind(row);
    if (kind === "casual") casual.push(row);
    else if (kind === "pdga") pdga.push(row);
    else competitive.push(row);
  }
  return {
    casual: playStatsKindPayload(casual, memberId),
    competitive: playStatsKindPayload(competitive, memberId),
    pdga: playStatsKindPayload(pdga, memberId),
  };
}

export function pdgaRowsFromStats(stats, memberId, memberName) {
  const rounds = Array.isArray(stats && stats.play_rounds) ? stats.play_rounds : [];
  if (rounds.length) {
    return rounds.map((round) => ({
      breakdown: round.breakdown != null ? round.breakdown : round,
      group_format: playRowGroup(round),
      kind: "pdga",
      member_id: memberId,
      name: memberName || String(stats && stats.name || "Player"),
      scoring_style: playRowStyle(round),
    }));
  }
  const play = stats && stats.play;
  if (!play || !num(play.holes)) return [];
  return [{
    breakdown: play,
    group_format: "singles",
    kind: "pdga",
    member_id: memberId,
    name: memberName || String(stats.name || "Player"),
    scoring_style: "stroke",
  }];
}

export function scoreMixRows(categories) {
  const byId = new Map((Array.isArray(categories) ? categories : []).map((row) => [row.id, row]));
  return SCORE_MIX_IDS.map((id) => byId.get(id)).filter(Boolean);
}

export function holeStatChips(stats) {
  if (!stats) return [];
  const chips = [];
  if (stats.fir) chips.push({ hit: stats.fir.hit === 1, id: "fir", label: "FIR" });
  if (stats.c1r) chips.push({ hit: stats.c1r.hit === 1, id: "c1r", label: "C1R" });
  else if (stats.c2r) chips.push({ hit: stats.c2r.hit === 1, id: "c2r", label: "C2R" });
  if (stats.parked && stats.parked.hit === 1) chips.push({ hit: true, id: "parked", label: "Parked" });
  if (stats.scramble && stats.scramble.hit === 1) chips.push({ hit: true, id: "scramble", label: "Scramble" });
  return chips;
}
