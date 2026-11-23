// Reading the club's Google Sheets for Admin › Import (pure; node-tested in tests/sheet-import.test.mjs). The admin
// pastes a sheet link (published or not) or the cells themselves; this reads the table, guesses which column is
// which from the headers, and turns each row into { line, name, pdga, udisc, tier, value } for the Worker
// (auth-worker/src/sheet-import.ts), which matches people and plans the changes.

export const SHEET_KINDS = {
  people: { label: "People and account tiers", value: null },
  balances: { label: "Store credit balances", value: "balance" },
  dues: { label: "Membership dues", value: "dues" },
  tags: { label: "Bag tag standings", value: "tag" },
};

export const FIELD_LABELS = {
  name: "Name", first: "First name", last: "Last name", pdga: "PDGA #", udisc: "UDisc name", tier: "Member or guest",
  balance: "Balance", dues: "Dues paid", tag: "Tag #",
};

/** Rows and cells from CSV, or from cells copied out of Google Sheets (tab-separated). Quotes and line breaks in
 *  quoted cells are kept. Blank rows keep their place (so row numbers match the sheet); trailing ones are dropped. */
export function parseTable(text) {
  const source = String(text ?? "").replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell.trim()); rows.push(row); }
  while (rows.length && !rows[rows.length - 1].some((value) => value !== "")) rows.pop();
  return rows;
}

/** The CSV address for a Google Sheets link: a published one as is, an ordinary one as its CSV export. "" if not a sheet. */
export function sheetCsvUrl(link) {
  let url;
  try { url = new URL(String(link ?? "").trim()); } catch { return ""; }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || !url.pathname.startsWith("/spreadsheets/d/")) return "";
  const gid = url.searchParams.get("gid") || (url.hash.match(/gid=(\d+)/) || [])[1] || "";
  if (url.pathname.startsWith("/spreadsheets/d/e/")) {
    const id = url.pathname.split("/")[4];
    if (!id) return "";
    return `https://docs.google.com/spreadsheets/d/e/${id}/pub?${gid ? "gid=" + gid + "&" : ""}single=true&output=csv`;
  }
  const id = url.pathname.split("/")[3];
  if (!id) return "";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? "&gid=" + gid : ""}`;
}

const HEADER_HINTS = {
  first: [/^first(\s*name)?$/],
  last: [/^last(\s*name)?$/, /^surname$/],
  name: [/^(full\s*)?name$/, /^player(\s*name)?$/, /^member(\s*name)?$/, /name/, /player/],
  pdga: [/pdga/],
  udisc: [/udisc/],
  tier: [/tier/, /^(account\s*)?type$/, /guest/, /^status$/, /member\s*\?/, /^member(ship)?$/],
  balance: [/balance/, /credit/, /wallet/, /owed/, /^amount$/, /\$/],
  dues: [/dues/, /paid/, /through/, /\bthru\b/, /renew/, /member(ship)?\s*(year|exp)/, /year/],
  tag: [/^tag(\s*(#|no|num|number))?$/, /bag\s*tag/, /tag/],
};

/** Which column holds each field, guessed from the header row (-1 = not there). */
export function guessColumns(kind, headers) {
  const names = (headers || []).map((value) => String(value ?? "").trim().toLowerCase());
  const used = new Set();
  const find = (field) => {
    for (const pattern of HEADER_HINTS[field] || []) {
      const index = names.findIndex((header, i) => !used.has(i) && header && pattern.test(header));
      if (index >= 0) { used.add(index); return index; }
    }
    return -1;
  };
  const valueField = SHEET_KINDS[kind]?.value;
  const mapping = {};
  for (const field of ["pdga", "udisc"]) mapping[field] = find(field);
  if (valueField) mapping[valueField] = find(valueField);
  mapping.first = find("first");
  mapping.last = find("last");
  mapping.name = mapping.first >= 0 && mapping.last >= 0 ? -1 : find("name");
  mapping.tier = find("tier");
  return mapping;
}

/** The fields an import of this kind shows column pickers for. */
export function fieldsFor(kind) {
  const value = SHEET_KINDS[kind]?.value;
  return ["name", "first", "last", "pdga", "udisc", ...(value ? [value] : []), "tier"];
}

/** "$12.50" -> 1250, "(5.00)" / "-$5" -> -500, "" -> null, anything else -> NaN. */
export function parseMoney(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const parens = /^\(\s*\$?\s*([0-9,]+(?:\.\d{1,2})?)\s*\)$/.exec(value);
  if (parens) {
    const normalized = parens[1].replace(/,/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
    const cents = Math.round(Number(normalized) * 100);
    return cents === 0 ? 0 : -cents;
  }
  const signed = /^(?:(-)\s*\$?\s*|\$\s*(-)\s*|\$?\s*)([0-9,]+(?:\.\d{1,2})?)$/.exec(value);
  if (!signed) return Number.NaN;
  const normalized = signed[3].replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  const cents = Math.round(Number(normalized) * 100);
  return (signed[1] || signed[2]) && cents !== 0 ? -cents : cents;
}

const PAID = /^(y|yes|paid|x|✓|✔|true|1|member|current|done)$/i;
const UNPAID = /^(n|no|unpaid|false|0|-|—|lapsed|not paid)$/i;
const UNPAID_WORD = /\b(?:unpaid|not\s*paid|lapsed|expired)\b|^no(?:\s*[-,:;(]|\s+(?:paid|dues)\b)/i;

/** A dues cell: a year ("2026", "Paid 2026"), a paid mark (that counts as `year`), unpaid/blank (null), else NaN. */
export function parseDues(text, year) {
  const value = String(text ?? "").trim();
  if (!value || UNPAID.test(value) || UNPAID_WORD.test(value)) return null;
  const found = value.match(/\b(20\d{2})\b/);
  if (found) return Number(found[1]);
  if (PAID.test(value)) return year;
  return Number.NaN;
}

/** "#7" / "7" / "Tag 7" -> 7; "" -> null; else NaN. */
export function parseTag(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const found = value.match(/^(?:tag\s*)?#?\s*(\d{1,4})$/i);
  return found ? Number(found[1]) : Number.NaN;
}

/** "Guest" / "G" -> guest, "Member" / "M" / "Paid" -> member, else "" (the import's default for new accounts). */
export function parseTier(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (/^(g|guest|guests|non-?member|visitor)$/.test(value)) return "guest";
  if (/^(m|member|members|club member|paid|current)$/.test(value)) return "member";
  return "";
}

const VALUE_ERRORS = { balance: "isn't an amount", dues: "isn't a year or paid mark", tag: "isn't a tag number" };

/**
 * Rows for the Worker. `table` includes the header row (sheet line 1), so data starts on line 2. Blank people rows are
 * dropped; a row whose value can't be read keeps an `error` (shown to the admin, not sent).
 */
export function readRows(kind, table, mapping, { duesYear } = {}) {
  const valueField = SHEET_KINDS[kind]?.value;
  const cell = (cells, index) => (index >= 0 ? String(cells[index] ?? "").trim() : "");
  const rows = [];
  (table || []).slice(1).forEach((cells, i) => {
    const line = i + 2;
    const name = (mapping.first >= 0 || mapping.last >= 0)
      ? [cell(cells, mapping.first), cell(cells, mapping.last)].filter(Boolean).join(" ")
      : cell(cells, mapping.name);
    const pdga = cell(cells, mapping.pdga).replace(/\D/g, "").slice(0, 8);
    const udisc = cell(cells, mapping.udisc).replace(/^@/, "");
    if (!name && !pdga && !udisc) return;
    const raw = valueField ? cell(cells, mapping[valueField]) : "";
    const value = valueField === "balance" ? parseMoney(raw) : valueField === "dues" ? parseDues(raw, duesYear) : valueField === "tag" ? parseTag(raw) : null;
    const row = { line, name: name.replace(/\s+/g, " ").slice(0, 80), pdga, udisc: /^[A-Za-z0-9._-]{1,50}$/.test(udisc) ? udisc : "", tier: parseTier(cell(cells, mapping.tier)), value: Number.isNaN(value) ? null : value };
    if (Number.isNaN(value)) row.error = `"${raw}" ${VALUE_ERRORS[valueField]}`;
    rows.push(row);
  });
  return rows;
}

/** "$12.50" for cents. */
export function moneyText(cents) {
  const value = Number(cents) || 0;
  return `${value < 0 ? "-" : ""}$${(Math.abs(value) / 100).toFixed(2)}`;
}
