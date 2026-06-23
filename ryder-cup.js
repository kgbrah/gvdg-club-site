// ryder-cup.js — pure, exported CSV parsers for the GVDG Ryder Cup matchplay sheet.
// No DOM access here so it can run headless under `node --test`. Rendering lives in
// ryder-cup.html. The two public functions are parseMatchGrid() and parseScoreboard().

// --- Small, robust CSV parser -------------------------------------------------
// Handles quoted fields, embedded commas, escaped quotes ("") and CRLF/CR/LF
// line endings. Returns an array of rows, each an array of string cells.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      // handle CRLF and lone CR
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    field += c;
    i += 1;
  }

  // flush trailing field/row (unless the text ended on a newline with nothing after)
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- Helpers ------------------------------------------------------------------
const cell = (row, idx) => (row && idx < row.length ? String(row[idx]) : '');
const norm = (s) => String(s == null ? '' : s).trim();

// "A&B": A = holes the leader was up, B = holes remaining. The sheet does NOT encode
// WHICH team (Red/Blue) won in the visible cells, so a match winner cannot be derived
// from the score alone. We only recognise an explicit tie (or "0&B"); otherwise the
// winner is unknown (null). Team totals come from the sheet's official "Points Scored"
// row, never re-derived from per-match scores.
function winnerFromScore(rawScore) {
  const s = norm(rawScore).toLowerCase();
  if (!s) return null; // unplayed
  if (s === 'tie' || s === 'as' || s === 'halved' || s === 'a/s') return 'tie';
  const m = s.match(/^(\d+)\s*&\s*(\d+)$/);
  if (m && parseInt(m[1], 10) === 0) return 'tie';
  return null; // played, but the winning color is not derivable from the sheet
}

// Locate the week-group columns by scanning the "Match-ups" header row for the
// repeating Red / Blue / (optional) Score sub-columns. Returns one descriptor
// per week: { redCol, blueCol, scoreCol|null }. This walks the wide grid and
// naturally skips the empty spacer columns between week groups, and tolerates
// weeks that have no Score sub-column yet (later, not-yet-played weeks).
function findWeekColumns(matchupRow) {
  const groups = [];
  for (let c = 0; c < matchupRow.length; c++) {
    if (norm(matchupRow[c]).toLowerCase() !== 'red') continue;
    const redCol = c;
    const blueCol = c + 1; // Blue always immediately follows Red
    const scoreCol =
      norm(matchupRow[c + 2]).toLowerCase() === 'score' ? c + 2 : null;
    groups.push({ redCol, blueCol, scoreCol });
  }
  return groups;
}

// Pair each week-column group with its label from the week-header row and its
// date from the "Dates" row. The label/date for a group is the nearest non-empty
// header cell at-or-before that group's Red column (labels sit one column left of
// the Red sub-column, e.g. "Week 1" header in col 1, Red in col 2).
function labelForColumn(headerRow, col) {
  for (let c = col; c >= 0; c--) {
    const v = norm(cell(headerRow, c));
    if (v) return { label: v, col: c };
  }
  return { label: '', col: -1 };
}

/**
 * Parse the wide weekly match grid CSV.
 * @param {string} csvText
 * @returns {{ weeks: Array<{label:string, dates:string, matches:Array<{num:number, red:string, blue:string, score:string, winner:('red'|'blue'|'tie'|null)}>}>, teamPoints:{red:number, blue:number} }}
 */
export function parseMatchGrid(csvText) {
  const rows = parseCsv(csvText);

  // Identify the structural rows by their first-cell labels.
  const headerRow = rows[0] || [];
  const datesRow = rows.find((r) => norm(r[0]).toLowerCase() === 'dates') || [];
  const matchupRowIdx = rows.findIndex(
    (r) => norm(r[0]).toLowerCase() === 'match-ups'
  );
  const matchupRow = matchupRowIdx >= 0 ? rows[matchupRowIdx] : [];

  const groups = findWeekColumns(matchupRow);

  // The numbered matchup rows live between the Match-ups row and the
  // "Points Scored" / totals rows. A data row is identified by a numeric value
  // in the matchup-number column (col 1 in this sheet — the cell to the left of
  // Week 1's Red column / under the Week-1 header).
  const numCol = groups.length ? groups[0].redCol - 1 : 1;

  const stopLabels = new Set([
    'points scored',
    'total points',
    'red home',
    'blue home',
    'winner',
    'tie',
  ]);

  const dataRows = [];
  if (matchupRowIdx >= 0) {
    for (let r = matchupRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const first = norm(row[0]).toLowerCase();
      if (stopLabels.has(first)) break; // reached the totals block
      const numRaw = norm(cell(row, numCol));
      if (!/^\d+$/.test(numRaw)) continue; // spacer / blank row
      dataRows.push(row);
    }
  }

  // Official team points come from the sheet's "Points Scored" row — the per-week
  // Red/Blue totals sit in that row at each week group's Red/Blue columns. We never
  // re-derive totals from the A&B scores (which don't say which color won).
  const pointsRow = rows.find((r) => norm(r[0]).toLowerCase() === 'points scored') || [];
  const toInt = (v) => {
    const n = parseInt(norm(v), 10);
    return Number.isNaN(n) ? 0 : n;
  };

  const teamPoints = { red: 0, blue: 0 };
  for (const g of groups) {
    teamPoints.red += toInt(cell(pointsRow, g.redCol));
    teamPoints.blue += toInt(cell(pointsRow, g.blueCol));
  }

  const weeks = groups.map(({ redCol, blueCol, scoreCol }) => {
    const { label, col: labelCol } = labelForColumn(headerRow, redCol);
    const dates = norm(cell(datesRow, labelCol >= 0 ? labelCol : redCol));

    const matches = dataRows.map((row) => {
      const num = parseInt(norm(cell(row, numCol)), 10);
      const red = norm(cell(row, redCol));
      const blue = norm(cell(row, blueCol));
      const score = scoreCol != null ? norm(cell(row, scoreCol)) : '';
      return { num, red, blue, score, winner: winnerFromScore(score) };
    });

    return { label, dates, matches };
  });

  return { weeks, teamPoints };
}

/**
 * Parse the scoreboard CSV (team names + rosters).
 * Layout: a header row "SCORE BOARD <Red team> ... <Blue team> ..."; then numbered
 * roster rows where the Red roster sits in the first columns and the Blue roster
 * in a later column block. We locate the two team-name anchors on the header row
 * and read each roster column directly to its right.
 * @param {string} csvText
 * @returns {{ red:{name:string, players:string[]}, blue:{name:string, players:string[]} }}
 */
export function parseScoreboard(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) {
    return { red: { name: 'Red', players: [] }, blue: { name: 'Blue', players: [] } };
  }

  const header = rows[0];

  // Red team name is in the first header cell, e.g. "SCORE BOARD Juan Team".
  let redName = norm(header[0]).replace(/^score\s*board\s*/i, '').trim() || 'Red';

  // Blue team name is the next header cell that ends in "Team" (or the first
  // non-empty cell after a gap). Track its column so we can read the Blue roster.
  let blueNameCol = -1;
  let blueName = 'Blue';
  for (let c = 1; c < header.length; c++) {
    const v = norm(header[c]);
    if (!v) continue;
    if (/team$/i.test(v)) {
      blueName = v;
      blueNameCol = c;
      break;
    }
  }
  // Fallback: if no "...Team" cell, take the first non-empty header cell after
  // the leading red-stats block (Wins/Losses/Ties/Points columns).
  if (blueNameCol === -1) {
    for (let c = 1; c < header.length; c++) {
      const v = norm(header[c]).toLowerCase();
      if (v && !['wins', 'losses', 'ties', 'points', 'total'].includes(v)) {
        blueName = norm(header[c]);
        blueNameCol = c;
        break;
      }
    }
  }

  // Roster layout (confirmed from fixture): Red roster name is in col 1 (the
  // cell right of the "#" index col 0). Blue roster name sits one column right of
  // the Blue team-name anchor (the Blue "#" index is at blueNameCol, the name at
  // blueNameCol + 1).
  const redNameCol = 1;
  const blueRosterCol = blueNameCol >= 0 ? blueNameCol + 1 : -1;

  const redPlayers = [];
  const bluePlayers = [];
  const stopFirst = new Set(['', 'total']);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const idx = norm(cell(row, 0)).toLowerCase();
    if (stopFirst.has(idx)) continue; // skip the trailing "Total" / blank row

    const redP = norm(cell(row, redNameCol));
    if (redP) redPlayers.push(redP);

    if (blueRosterCol >= 0) {
      const blueP = norm(cell(row, blueRosterCol));
      if (blueP) bluePlayers.push(blueP);
    }
  }

  return {
    red: { name: redName, players: redPlayers },
    blue: { name: blueName, players: bluePlayers },
  };
}
