import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import { MEMBER_ARCHIVE_SCHEMA } from "../../src/members-app/member-archive-model.js";

const OWNER = "member-fixture";
const id = "44226890-895a-406b-ab45-000000000001";
const played = "2026-06-02 1530-0400";
const round = { owner: OWNER, kind: "round", sourceId: "udisc:initial",
  data: { round: { courseName: "West Meadow", source: "udisc", playedDate: "2026-06-02", playedAt: "2026-06-02T15:30:00",
    layoutName: "Blue baskets", total: 6, toPar: 0, group: "unknown",
    holes: [{ hole: 1, par: 3, points: null, strokes: 2, distanceFt: 278, marks: [{ lat: 35, lng: -82, n: 1 }] },
      { hole: 2, par: 3, points: null, strokes: 4, distanceFt: 318, marks: [] }] },
  clock: { sourcePlayedAt: played, resultRecordedAt: "2026-06-04 21:30:00", startedAt: null, finalizedAt: null } } };
const disc = { owner: OWNER, kind: "disc", sourceId: id,
  data: { id, revision: 1, occurredOn: "2026-06-02", updatedAt: 1770000000000,
    record: { brand: "Innova", model: "Teebird", plastic: "Star", weightGrams: 175, notes: "Fieldwork", inBag: true, archived: false } } };
const rows = new Map();
let nextId = 1;
let commits = 0;
let previews = 0;
let firstCommitGate;
const screenDir = process.env.GVDG_ARCHIVE_QA_SCREENSHOTS;
const app = `
<!doctype html><html lang="en"><head>
<title>Personal archive fixture</title><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/member-archive.css">
<style>
* { box-sizing: border-box; }
body { font-family: Archivo, system-ui, sans-serif; background: var(--bg-primary); color: var(--text-primary); }
main { display: grid; gap: 1rem; max-inline-size: 49rem; margin: 2rem auto; padding: 0 1rem; }
main > h1 { font-size: 1.4rem; margin: 0; }
.player-card-meta { color:var(--text-muted); font-size:.83rem; line-height:1.45; }
</style>
</head><body data-auth-base="/fixture"><main><h1>Round history</h1><div id="root"></div></main>
<script type="module" src="/archive-qa-entry.js"></script></body></html>
`;
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { PersonalArchivePanel } from "/src/members-app/member-archive-panel.js";
const reactRoot = createRoot(document.querySelector("#root"));
window.setArchiveAccount = (token) => reactRoot.render(React.createElement(PersonalArchivePanel,{token}));
window.setArchiveAccount("qa-member");
`;
const vite = await createServer({
  configFile: false,
  cacheDir: process.env.GVDG_ARCHIVE_QA_CACHE || "/tmp/gvdg-member-archive-qa",
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { include: ["react", "react-dom/client", "lucide-react"], noDiscovery: true },
  plugins: [{
    name: "archive-fixture",
    resolveId(name) { return name === "/archive-qa-entry.js" ? name : null; },
    load(name) { return name === "/archive-qa-entry.js" ? entry : null; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/archive-qa.html") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(await server.transformIndexHtml(req.url, app));
          return;
        }
        const base = "/fixture/me/archive";
        if (!url.pathname.startsWith(base)) { next(); return; }
        const owner = req.headers.authorization === "Bearer qa-member" ? OWNER : "other-fixture";
        const tail = url.pathname.slice(base.length);
        const data = [...rows.values()].filter(({ entry }) => entry.owner === owner);
        function reply(body, status = 200) {
          res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "private, no-store" });
          res.end(JSON.stringify(body));
        }
        if (!tail) {
          reply({ memberId: owner, schemaVersion: MEMBER_ARCHIVE_SCHEMA, exportedAt: "2026-06-04T21:30:00Z",
            definitions: {}, entries: owner === OWNER ? (url.searchParams.has("cursor") ? [disc] : [round]) : [],
            next: owner === OWNER && !url.searchParams.has("cursor") ? "part-two" : null });
          return;
        }
        if (tail === "/records") { reply({ rows: data, next: null }); return; }
        if (tail.startsWith("/records/") && req.method === "DELETE") {
          const id = Number(tail.split("/").at(-1));
          if (!data.some((row) => row.id === id)) { reply({ error: "not_found" }, 404); return; }
          rows.delete(id);
          reply({ ok: true });
          return;
        }
        if (tail !== "/restore") { reply({ error: "not_found" }, 404); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.memberId !== owner) { reply({ error: "wrong_owner" }, 403); return; }
        if (body.mode === "preview") {
          previews++;
          reply({ valid: body.entries.length });
          return;
        }
        assert.equal(body.mode, "restore");
        commits++;
        let saved = 0;
        for (const entry of body.entries) {
          if (data.some((row) => JSON.stringify(row.entry) === JSON.stringify(entry))) continue;
          rows.set(nextId, { id: nextId++, entry, importedAt: "2026-06-05T19:30:00Z" });
          saved++;
        }
        const gate = firstCommitGate;
        firstCommitGate = null;
        await gate;
        reply({ saved, duplicates: body.entries.length - saved });
      });
    },
  }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(25_000);
  await page.goto(origin + "/archive-qa.html");
  await page.getByRole("heading", { name: "Personal archive" }).waitFor({ timeout: 60_000 });
  if (screenDir) await mkdir(screenDir, { recursive: true });
  const download = async (name) => {
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name, exact: true }).click()]);
    return readFile(await file.path());
  };
  const backup = await download("Download backup");
  assert.equal(JSON.parse(backup).entries.length, 2);
  assert.ok(backup.includes(played));
  const csv = (await download("Download CSV")).toString();
  assert.match(csv, /^kind,source_id,round_source,recorded_at,data_json/);
  assert.ok(csv.includes(played));
  const choose = (buffer) => page.locator("input[type=file]").setInputFiles({ name: "gvdg-backup.json", mimeType: "application/json", buffer });
  await choose(backup);
  await page.getByRole("region", { name: "Backup preview" }).waitFor();
  if (screenDir) await page.screenshot({ path: screenDir + "/archive-preview-390.png", fullPage: true });
  await page.getByRole("button", { name: "Cancel restore" }).click();
  await page.getByText("Cancelled.", { exact: true }).waitFor();
  assert.equal(previews, 1);
  assert.equal(commits, 0);
  assert.equal(rows.size, 0);
  await choose(backup);
  await page.getByRole("button", { name: "Restore copies", exact: true }).click();
  await page.getByText("2 restored · 0 already saved.", { exact: true }).waitFor();
  await choose(backup);
  await page.getByRole("button", { name: "Restore copies", exact: true }).click();
  await page.getByText("0 restored · 2 already saved.", { exact: true }).waitFor();
  assert.equal(rows.size, 2);
  await page.getByText("Restored copies", { exact: true }).click();
  await page.getByText("West Meadow", { exact: true }).click();
  await page.getByRole("table").waitFor();
  await page.getByText(played, { exact: true }).waitFor();
  for (const width of [390, 320, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate((width) => {
      document.documentElement.dataset.theme = width === 320 ? "dark" : "light";
      document.documentElement.style.fontSize = width === 320 ? "125%" : "";
    }, width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Archive page does not overflow at " + width);
    if (screenDir) await page.screenshot({ path: screenDir + "/archive-restored-" + width + ".png", fullPage: true });
  }
  const single = await download("Download this copy");
  assert.equal(JSON.parse(single).entries.length, 1);
  await page.getByRole("button", { name: "Remove restored copy", exact: true }).click();
  await page.getByRole("button", { name: "Keep copy" }).click();
  assert.equal(rows.size, 2);
  await page.getByRole("button", { name: "Remove restored copy", exact: true }).click();
  await page.getByRole("button", { name: "Remove copy", exact: true }).click();
  await page.getByText("Restored copy removed.", { exact: true }).waitFor();
  assert.equal(rows.size, 1);
  await page.evaluate(() => window.setArchiveAccount("other-account"));
  await page.getByText("Restored copies", { exact: true }).click();
  await page.getByText("No restored copies yet.", { exact: true }).waitFor();
  await choose(backup);
  await page.getByText("This backup belongs to a different account.", { exact: true }).waitFor();
  assert.equal(commits, 2);
  await page.evaluate(() => window.setArchiveAccount("qa-member"));
  const batch = { ...JSON.parse(backup), entries: Array.from({ length: 17 }, (_, index) => {
    const sourceId = "44226890-895a-406b-ab45-" + String(10 + index).padStart(12, "0");
    return { ...disc, sourceId, data: { ...disc.data, id: sourceId } };
  }) };
  let release;
  firstCommitGate = new Promise((resolve) => { release = resolve; });
  await choose(Buffer.from(JSON.stringify(batch)));
  await page.getByRole("button", { name: "Restore copies", exact: true }).click();
  await page.getByText("Restoring part 1 of 2…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop after this part" }).click();
  release();
  await page.getByText("Restore stopped. 16 restored · 0 already saved. You can resume this file.", { exact: true }).waitFor();
  assert.equal(commits, 3);
  await page.getByRole("button", { name: "Restore copies", exact: true }).click();
  await page.getByText("1 restored · 16 already saved.", { exact: true }).waitFor();
  assert.equal(commits, 5);
  assert.equal(rows.size, 18);
  assert.deepEqual(errors, []);
  console.log("Personal archive browser checks passed at widths 320, 390 and 1280.");
} finally {
  await browser.close();
  await vite.close();
}
