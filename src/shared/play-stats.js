import { holePlayStats } from "./shot-stats-model.js";
export { PARKED_FT, FAIRWAY_WIDTH_FT, fairwayHit, lineOffsetFt, regulationStrokes, holePlayStats } from "./shot-stats-model.js";

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function emptyPlayTotals() {
  return {
    holes: 0,
    aces: 0,
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
    c1x_putt_hit: 0,
    c1x_putt_att: 0,
    shot_eligible_holes: 0,
    shot_count_matched_holes: 0,
    shot_verified_holes: 0,
    shot_incomplete_holes: 0,
    c2_putt_hit: 0,
    c2_putt_att: 0,
  };
}

function applyScoreMix(totals, par, strokes) {
  if (!Number.isInteger(strokes) || strokes <= 0 || !Number.isInteger(par) || par <= 0) return;
  totals.holes += 1;
  const delta = strokes - par;
  if (strokes === 1) totals.aces += 1;
  else if (delta <= -2) totals.eagles += 1;
  else if (delta === -1) totals.birdies += 1;
  else if (delta === 0) totals.pars += 1;
  else if (delta === 1) totals.bogeys += 1;
  else totals.doubles_plus += 1;
  if (delta === -1) totals.birdie_hit += 1;
  if (delta === 0) totals.par_hit += 1;
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
  addSample(totals, stats.c1xPutt, "c1x_putt_hit", "c1x_putt_att");
  if (Number.isInteger(Number(score)) && Number(score) > 1) {
    totals.shot_eligible_holes += 1;
    if (stats.shotQuality === "estimated") totals.shot_count_matched_holes += 1;
    if (stats.shotQuality === "recorded") totals.shot_verified_holes += 1;
    if (stats.shotQuality === "incomplete") totals.shot_incomplete_holes += 1;
  }
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
  const one = list.find((row) => row && !row.removed && (standing?.memberId
    ? row.memberId === standing.memberId
    : standing && !row.memberId && row.name === standing.name));
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
  const aces = num(obj.aces);
  let eagles = num(obj.eagles);
  const birdies = num(obj.birdies);
  const pars = num(obj.pars);
  const bogeys = num(obj.bogeys);
  const doubles = num(obj.doubles_plus);
  const mix = aces + eagles + birdies + pars + bogeys + doubles;
  const holes = num(obj.holes);
  if (holes && mix > holes && aces) eagles = Math.max(0, eagles - aces);
  totals.aces = aces;
  totals.eagles = eagles;
  totals.birdies = birdies;
  totals.pars = pars;
  totals.bogeys = bogeys;
  totals.doubles_plus = doubles;
  totals.holes = holes || (aces + eagles + birdies + pars + bogeys + doubles);
  totals.birdie_hit = birdies;
  totals.par_hit = pars;
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
  totals.c1x_putt_hit = num(obj.c1x_putt_hit);
  totals.c1x_putt_att = num(obj.c1x_putt_att);
  totals.shot_eligible_holes = num(obj.shot_eligible_holes);
  totals.shot_count_matched_holes = num(obj.shot_count_matched_holes);
  totals.shot_verified_holes = num(obj.shot_verified_holes);
  totals.shot_incomplete_holes = num(obj.shot_incomplete_holes);
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
  { att: "holes", group: "mix", hit: "aces", id: "ace", invert: false, label: "Ace", min: 18, short: "Ace", tone: "ace" },
  { att: "holes", group: "mix", hit: "eagles", id: "eagle", invert: false, label: "Eagle", min: 18, short: "Eagle", tone: "eagle" },
  { att: "holes", group: "mix", hit: "birdies", id: "birdieMix", invert: false, label: "Birdie", min: 18, short: "Birdie", tone: "birdie" },
  { att: "holes", group: "mix", hit: "pars", id: "parMix", invert: false, label: "Par", min: 18, short: "Par", tone: "par" },
  { att: "holes", group: "mix", hit: "bogeys", id: "bogey", invert: true, label: "Bogey", min: 18, short: "Bogey", tone: "bogey" },
  { att: "holes", group: "mix", hit: "doubles_plus", id: "double", invert: true, label: "Double+", min: 18, short: "Dbl+", tone: "double" },
  { att: "holes", group: "score", hit: "birdie_hit", id: "birdie", invert: false, label: "Birdie", min: 18, short: "Birdie", tone: "birdie" },
  { att: "holes", group: "score", hit: "par_hit", id: "par", invert: false, label: "Par", min: 18, short: "Par", tone: "par" },
  { att: "fir_att", group: "throw", hit: "fir_hit", id: "fir", invert: false, label: "Fairways", min: 9, short: "FIR", tone: null },
  { att: "c1r_att", group: "throw", hit: "c1r_hit", id: "c1r", invert: false, label: "C1 in reg", min: 9, short: "C1R", tone: null },
  { att: "c2r_att", group: "throw", hit: "c2r_hit", id: "c2r", invert: false, label: "C2 in reg", min: 9, short: "C2R", tone: null },
  { att: "c1_putt_att", group: "throw", hit: "c1_putt_hit", id: "c1Putt", invert: false, label: "C1 putting", min: 8, short: "C1 putt", tone: null },
  { att: "c1x_putt_att", group: "throw", hit: "c1x_putt_hit", id: "c1xPutt", invert: false, label: "C1X putting", min: 8, short: "C1X putt", tone: null },
  { att: "c2_putt_att", group: "throw", hit: "c2_putt_hit", id: "c2Putt", invert: false, label: "C2 putting", min: 5, short: "C2 putt", tone: null },
  { att: "parked_att", group: "throw", hit: "parked_hit", id: "parked", invert: false, label: "Parked", min: 6, short: "Parked", tone: null },
  { att: "scramble_att", group: "throw", hit: "scramble_hit", id: "scramble", invert: false, label: "Scramble", min: 5, short: "Scramble", tone: null },
];

export const SCORE_MIX_IDS = PLAY_CATEGORIES.filter((row) => row.group === "mix").map((row) => row.id);
export const COMPACT_STAT_IDS = ["birdie", "par", "fir", "c1Putt"];
export const LIVE_ROUND_STAT_IDS = ["fir", "c1r", "c2r", "parked", "c1Putt", "c1xPutt", "c2Putt", "scramble", "birdie"];

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

export const PLAY_KINDS = ["competitive", "casual"];
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
  const style = String(row && (row.scoringStyle || row.scoring_style) || "").toLowerCase();
  if (style === "matchplay") return "matchplay";
  if (style === "putting") return "putting";
  return "stroke";
}

export function playGroupLabel(group) {
  if (group === "doubles") return "Doubles";
  if (group === "singles") return "Singles";
  return "All";
}

export function playStyleLabel(style) {
  if (style === "matchplay") return "Match play";
  if (style === "stroke") return "Stroke";
  if (style === "putting") return "Putting";
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

export function livePlayStatsView(totals) {
  const t = totals && typeof totals === "object" ? totals : emptyPlayTotals();
  return PLAY_CATEGORIES.map((category) => {
    const hit = num(t[category.hit]);
    const att = num(t[category.att]);
    return {
      group: category.group,
      id: category.id,
      label: category.label,
      mine: { att, hit, pct: statPct(hit, att) },
      short: category.short || category.label,
      tone: category.tone || null,
    };
  });
}

export function scoresFromHoleGrid(holeGrid) {
  const scores = {};
  for (const hole of Array.isArray(holeGrid) ? holeGrid : []) {
    if (!hole || hole.hole == null) continue;
    if (Number.isInteger(hole.score) && hole.score > 0) scores[hole.hole] = hole.score;
  }
  return scores;
}

export function liveRoundStatsFromCard({ holes, holeGrid, throwsByHole } = {}) {
  const totals = roundPlayStats(holes, throwsByHole, scoresFromHoleGrid(holeGrid));
  const categories = livePlayStatsView(totals);
  const byId = new Map(categories.map((row) => [row.id, row]));
  return {
    categories,
    mix: SCORE_MIX_IDS.map((id) => byId.get(id)).filter(Boolean),
    throwStats: LIVE_ROUND_STAT_IDS.map((id) => byId.get(id)).filter(Boolean),
    totals,
  };
}
