#!/usr/bin/env node
// UDisc import probe — fetch a REAL UDisc course page and report what the importer can pull from it.
//
// Why: the importer scrapes UDisc's HTML, but UDisc's markup shape is only knowable against the live
// site. This script runs the same extraction the worker uses (src/imports/udisc.ts) and prints a
// compact diagnostic so we can confirm the parser works — or see the real field names and tune it.
//
// Run from a machine with normal internet access (NOT a restricted CI/sandbox — udisc.com must be
// reachable). Node 18+ (global fetch):
//
//   node auth-worker/scripts/udisc-probe.mjs https://udisc.com/courses/west-meadowbrook-park-40Aw
//
// Then paste the printed JSON back into the chat. It contains no secrets — just public course markup
// diagnostics. The helpers below mirror src/imports/udisc.ts (diagnostic copy; keep roughly in sync).

const url = process.argv[2] || "https://udisc.com/courses/west-meadowbrook-park-40Aw";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- extraction helpers (mirror of the worker parser) ---
function titleFromHtml(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = html.match(/<title>([^<]+)<\/title>/i);
  let name = (og?.[1] ?? title?.[1] ?? "").trim();
  name = name.replace(/&middot;/gi, "·").replace(/&amp;/gi, "&");
  return name.replace(/\s*[·|\-–]\s*UDisc.*$/i, "").trim();
}

function nextFlightText(html) {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
    try {
      out += JSON.parse(m[1]);
    } catch {
      /* skip */
    }
  }
  return out;
}

function extractBalanced(text, openIdx) {
  const open = text[openIdx];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

function isHoleish(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  return typeof x.par === "number" || typeof x.holeNumber === "number" || typeof x.number === "number";
}

function holeArraysFromText(text) {
  const found = [];
  for (const m of text.matchAll(/"holes"\s*:\s*\[/g)) {
    const bracket = text.indexOf("[", m.index + m[0].length - 1);
    if (bracket < 0) continue;
    const arrStr = extractBalanced(text, bracket);
    if (!arrStr) continue;
    try {
      const arr = JSON.parse(arrStr);
      if (Array.isArray(arr) && arr.length > 0 && arr.length <= 40 && arr.filter(isHoleish).length >= Math.ceil(arr.length / 2)) {
        found.push(arr);
      }
    } catch {
      /* skip */
    }
  }
  return found;
}

// Cap nested arrays to their first element so the sample shows structure without dumping every hole.
function trimSample(obj) {
  return JSON.parse(
    JSON.stringify(obj, (k, v) => (Array.isArray(v) && v.length > 1 ? [v[0], `…+${v.length - 1} more`] : v)),
  );
}

// Safety net: if the "holes":[...] anchor misses, show context around the first "par": so we can see
// the real container key/shape UDisc uses.
function parContext(text) {
  const i = text.search(/"par"\s*:/);
  if (i < 0) return null;
  return text.slice(Math.max(0, i - 250), i + 250);
}

const res = await fetch(url, {
  headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
});
const html = await res.text();

const typedScripts = [
  ...html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi),
].map((m) => m[1]);
const flight = nextFlightText(html);
const fromFlight = holeArraysFromText(flight);
const fromHtml = holeArraysFromText(html);
const best = [...fromFlight, ...fromHtml].reduce((b, a) => (a.length > b.length ? a : b), []);

const report = {
  url,
  finalUrl: res.url,
  status: res.status,
  bytes: html.length,
  title: titleFromHtml(html),
  typedJsonScriptCount: typedScripts.length,
  typedJsonHasPar: typedScripts.some((s) => /"par"\s*:/.test(s)),
  hasNextF: /self\.__next_f\.push/.test(html),
  flightTextLength: flight.length,
  holesKeyMatches: { html: (html.match(/"holes"\s*:\s*\[/g) || []).length, flight: (flight.match(/"holes"\s*:\s*\[/g) || []).length },
  holeArrayLengthsFound: { fromFlight: fromFlight.map((a) => a.length), fromHtml: fromHtml.map((a) => a.length) },
  bestHoleCount: best.length,
  firstHoleKeys: best[0] ? Object.keys(best[0]) : null,
  firstHoleSample: best[0] ? trimSample(best[0]) : null,
  parContextSample: best.length ? null : parContext(flight) || parContext(html),
};

console.log(JSON.stringify(report, null, 2));
