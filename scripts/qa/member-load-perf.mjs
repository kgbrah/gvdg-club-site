// First-load performance harness for the member app (gvdg-members.html).
//
// Serves the BUILT site (run `npm run build` first) with brotli like Cloudflare Pages, runs the
// members-dashboard fixture API as a real cross-origin HTTP server (so CORS preflights and network
// throttling apply to API calls too), and loads the page in Chromium as a first visit on a typical
// phone: 390x844, 150 ms latency, 1.6 Mbps down / 750 kbps up, 4x CPU slowdown, service workers
// blocked.
//
// Scenarios:
//   signed-out  the login screen
//   signed-in   Home with a stored member token
//
// Reported per scenario (median of N runs):
//   usable    navigation start -> first usable screen
//             signed-out: login form rendered (PDGA/UDisc + PIN inputs and the Log In button)
//             signed-in:  member nav + Home hero with the member's name + the round card ready
//   home      signed-in only: every Home card has its data (rating, wallet, last round, up next)
//   lcp       largest contentful paint
//   long      total long-task time (main-thread tasks over 50 ms) up to `usable`
//   long5s    total long-task time until 5 s after `usable`
//   js        JavaScript bytes transferred before `usable` (compressed, as on the wire)
//   total     all bytes transferred by the time the page has loaded and settled
//
// Usage:
//   npm run build
//   CHROMIUM_PATH=/usr/bin/chromium node scripts/qa/member-load-perf.mjs [--runs 3]
//     [--scenario signed-out|signed-in] [--waterfall] [--json out.json] [--profile prefix]
//   --profile writes a V8 CPU profile of each scenario's first run to <prefix>-<scenario>.cpuprofile.
// Env: GVDG_QA_NO_SANDBOX=1, GVDG_PERF_API_MS (simulated server time per API call, default 200).

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { chromium } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const runs = Math.max(1, Number(option("--runs", "3")) || 3);
const onlyScenario = option("--scenario", "");
const jsonOut = option("--json", "");
const showWaterfall = flag("--waterfall");
const profilePrefix = option("--profile", "");
const apiDelayMs = Math.max(0, Number(process.env.GVDG_PERF_API_MS ?? 200) || 0);

const NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
const CPU_SLOWDOWN = 4;
const VIEWPORT = { width: 390, height: 844 };

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
  [".webmanifest", "application/manifest+json"],
]);
const compressible = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".webmanifest"]);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// Static site, compressed like Cloudflare Pages. The API base is injected so the fixture API can use any port.
async function startSiteServer(apiOrigin) {
  const cache = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/version.json") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end('{"commit":"member-load-perf"}');
        return;
      }
      const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.join(repoRoot, path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, ""));
      if (!filePath.startsWith(repoRoot + path.sep)) {
        response.writeHead(403);
        response.end();
        return;
      }
      const ext = path.extname(filePath);
      let entry = cache.get(filePath);
      if (!entry) {
        let body = await readFile(filePath);
        if (ext === ".html") body = Buffer.from(String(body).replace('data-auth-base=""', `data-auth-base="${apiOrigin}"`));
        const encoded = compressible.has(ext)
          ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } })
          : null;
        entry = { body, encoded };
        cache.set(filePath, entry);
      }
      const accepts = /\bbr\b/.test(String(request.headers["accept-encoding"] || ""));
      const headers = {
        "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
        "Cache-Control": requestPath.startsWith("/img/") ? "public, max-age=86400" : "public, max-age=0, must-revalidate",
      };
      if (entry.encoded && accepts) {
        response.writeHead(200, { ...headers, "Content-Encoding": "br", Vary: "Accept-Encoding" });
        response.end(entry.encoded);
      } else {
        response.writeHead(200, headers);
        response.end(entry.body);
      }
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500);
      response.end();
    }
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

// The members-dashboard fixture routes, served over real HTTP from another origin so each call pays
// latency, bandwidth and a CORS preflight like the deployed Worker.
async function startApiServer() {
  let handler = null;
  await installMemberDashboardApiRoutes({ route: async (_pattern, fn) => { handler = fn; } }, "");
  const cors = (origin) => ({
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const origin = request.headers.origin;
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors(origin));
        response.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, apiDelayMs));
      const url = `http://api.local${request.url}`;
      const body = Buffer.concat(chunks).toString();
      await handler({
        request: () => ({ url: () => url, method: () => request.method, postData: () => body, headers: () => request.headers }),
        fulfill: async ({ status = 200, contentType = "application/json", body: payload = "" }) => {
          response.writeHead(status, { ...cors(origin), "Content-Type": contentType, "Cache-Control": "no-store" });
          response.end(payload);
        },
        fallback: async () => { response.writeHead(404, cors(origin)); response.end(); },
        continue: async () => { response.writeHead(404, cors(origin)); response.end(); },
      });
    });
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

// Installed before any page script: records long tasks, LCP and the moment each readiness condition first holds.
function probeScript() {
  const marks = {};
  const longTasks = [];
  let lcp = 0;
  window.__perf = { marks, longTasks, lcp: () => lcp };
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push([entry.startTime, entry.duration]); })
      .observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) lcp = entry.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  const visible = (node) => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
  const checks = {
    signedOutUsable: () => {
      const gate = document.querySelector('[data-react-auth-gate="login"]');
      if (!gate) return false;
      const button = [...gate.querySelectorAll("button")].find((node) => node.textContent.trim() === "Log In");
      return visible(document.getElementById("identifierInput")) && visible(document.getElementById("pinInput")) && visible(button);
    },
    signedInUsable: () => {
      const nav = document.querySelector('nav.player-app-nav');
      const hero = document.querySelector("[data-react-home-hero]");
      const round = document.querySelector('[data-react-live-scoring="ready"]');
      return visible(nav) && visible(hero) && hero.textContent.includes("QA Admin") && visible(round);
    },
    homeComplete: () => {
      const hero = document.querySelector("[data-react-home-hero]");
      return Boolean(hero && /941/.test(hero.textContent)
        && document.querySelector('[data-react-wallet="ready"]')
        && document.querySelector('[data-react-home-last-round="ready"]')
        && document.querySelector("[data-react-home-next]:not([data-react-home-next=\"empty\"])")
        && document.querySelector('[data-react-home-jobs="ready"]'));
    },
  };
  const pending = new Set(Object.keys(checks));
  const evaluate = () => {
    for (const name of [...pending]) {
      let ok = false;
      try { ok = checks[name](); } catch {}
      if (ok) { marks[name] = performance.now(); pending.delete(name); }
    }
    if (!pending.size) observer.disconnect();
  };
  const observer = new MutationObserver(evaluate);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

async function measure(browser, siteOrigin, scenario, profilePath = "") {
  const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
  if (scenario === "signed-in") {
    await context.addInitScript(() => {
      try { localStorage.setItem("gvdg_member_token", "qa-token"); localStorage.setItem("gvdg_member_name", "QA Admin"); } catch {}
    });
  }
  await context.addInitScript(probeScript);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", NETWORK);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

  if (profilePath) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  const mark = scenario === "signed-in" ? "signedInUsable" : "signedOutUsable";
  await page.goto(`${siteOrigin}/gvdg-members.html`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForFunction((name) => window.__perf?.marks?.[name] != null, mark, { timeout: 60_000, polling: 250 });
  if (scenario === "signed-in") {
    await page.waitForFunction(() => window.__perf?.marks?.homeComplete != null, null, { timeout: 60_000, polling: 250 }).catch(() => {});
  }
  // Let the page settle so trailing work (lazy chunks, background calls) is counted in long5s/total, and wait
  // for the load event so a late image (the wallpaper) still counts toward LCP and the bytes total.
  await page.waitForTimeout(5_000);
  await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 90_000, polling: 250 });
  await page.waitForTimeout(500);
  if (profilePath) {
    const { profile } = await cdp.send("Profiler.stop");
    await writeFile(profilePath, JSON.stringify(profile));
  }
  const result = await page.evaluate((name) => {
    const { marks, longTasks, lcp } = window.__perf;
    const usable = marks[name];
    const resources = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation")[0];
    const sumLong = (limit) => Math.round(longTasks.filter(([start]) => start < limit).reduce((sum, [, duration]) => sum + duration, 0));
    const isJs = (entry) => /\.m?js(\?|$)/.test(entry.name);
    return {
      usable: Math.round(usable),
      home: marks.homeComplete != null ? Math.round(marks.homeComplete) : null,
      lcp: Math.round(lcp()),
      long: sumLong(usable),
      long5s: sumLong(usable + 5_000),
      jsKb: Math.round(resources.filter((entry) => isJs(entry) && entry.responseEnd <= usable).reduce((sum, entry) => sum + entry.transferSize, 0) / 1024),
      totalKb: Math.round((resources.reduce((sum, entry) => sum + entry.transferSize, 0) + (nav?.transferSize || 0)) / 1024),
      waterfall: [nav, ...resources].filter(Boolean).map((entry) => ({
        name: entry.name.replace(location.origin + "/", "").replace(/^https?:\/\/127\.0\.0\.1:\d+/, "API "),
        start: Math.round(entry.startTime),
        end: Math.round(entry.responseEnd),
        kb: Math.round((entry.transferSize || 0) / 1024),
      })),
    };
  }, mark);
  await context.close();
  if (errors.length) result.errors = errors;
  return result;
}

const median = (values) => {
  const list = values.filter((value) => value != null).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
};

const api = await startApiServer();
const site = await startSiteServer(api.origin);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});
const summary = {};
try {
  for (const scenario of ["signed-out", "signed-in"]) {
    if (onlyScenario && onlyScenario !== scenario) continue;
    const results = [];
    for (let index = 0; index < runs; index++) {
      const result = await measure(browser, site.origin, scenario, profilePrefix && index === 0 ? `${profilePrefix}-${scenario}.cpuprofile` : "");
      results.push(result);
      const home = result.home != null ? ` home ${result.home}ms` : "";
      console.log(`${scenario} run ${index + 1}: usable ${result.usable}ms${home} lcp ${result.lcp}ms long ${result.long}ms long5s ${result.long5s}ms js ${result.jsKb}KB total ${result.totalKb}KB${result.errors ? " ERRORS " + result.errors.join(" | ") : ""}`);
    }
    if (showWaterfall) {
      console.log(`\n${scenario} waterfall (run 1):`);
      for (const row of results[0].waterfall.sort((a, b) => a.start - b.start)) {
        console.log(`  ${String(row.start).padStart(6)} -> ${String(row.end).padStart(6)}  ${String(row.kb).padStart(4)}KB  ${row.name}`);
      }
      console.log("");
    }
    summary[scenario] = {
      usable: median(results.map((row) => row.usable)),
      home: median(results.map((row) => row.home)),
      lcp: median(results.map((row) => row.lcp)),
      long: median(results.map((row) => row.long)),
      long5s: median(results.map((row) => row.long5s)),
      jsKb: median(results.map((row) => row.jsKb)),
      totalKb: median(results.map((row) => row.totalKb)),
      runs: results.map(({ waterfall, ...row }) => row),
    };
  }
} finally {
  await browser.close();
  await site.close();
  await api.close();
}

const cell = (value, unit) => (value == null ? "-" : `${value}${unit}`);
console.log(`\nMember app first load, median of ${runs} (390x844, 150 ms RTT, 1.6/0.75 Mbps, 4x CPU, no SW, API +${apiDelayMs} ms)`);
console.log("| Scenario | Usable | Home data | LCP | Long tasks to usable | Long tasks +5 s | JS before usable | Total transferred |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [scenario, row] of Object.entries(summary)) {
  console.log(`| ${scenario} | ${cell(row.usable, " ms")} | ${cell(row.home, " ms")} | ${cell(row.lcp, " ms")} | ${cell(row.long, " ms")} | ${cell(row.long5s, " ms")} | ${cell(row.jsKb, " KB")} | ${cell(row.totalKb, " KB")} |`);
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(summary, null, 2));
