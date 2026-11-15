import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import { EMPTY_PRACTICE, metersFromDistance, puttingMakeTotals } from "../../src/members-app/practice-model.js";

const members = new Map([["qa-one", "qa-one"], ["qa-two", "qa-two"]]);
const serveOnly = Boolean(process.env.GVDG_PRACTICE_QA_SERVE);
const records = new Map();
const operations = new Map();
let available = true;
let loseNextResponse = false;
function db(owner) {
  if (!records.has(owner)) records.set(owner, new Map());
  return records.get(owner);
}

function summary(owner) {
  const rows = [...db(owner).values()];
  const putting = rows.filter((row) => row.kind === "putting");
  const throws = rows.filter((row) => row.kind === "throw");
  return {
    ...EMPTY_PRACTICE, owner,
    discs: rows.filter((row) => row.kind === "disc"),
    throws: { items: throws, next: null }, putting: { items: putting, next: null },
    puttingTotals: { ...puttingMakeTotals(putting.flatMap((row) => row.record.stations)), sessions: putting.length },
  };
}

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const vite = await createServer({
  configFile: false, cacheDir: process.env.GVDG_PRACTICE_QA_CACHE || "/tmp/gvdg-practice-browser-qa",
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { entries: ["src/members-app/main.js"] },
  plugins: [{
    name: "gvdg-practice-test",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url, "http://localhost").pathname;
        if (path === "/practice-qa.html") {
          const html = (await readFile("gvdg-members.html", "utf8"))
            .replace(/<link[^>]+https:[^>]+>/g, "")
            .replace('data-auth-base=""', 'data-auth-base="/fixture"')
            .replace(/src="members-app\/[^"]+"/, 'src="/src/members-app/main.js"');
          res.setHeader("Content-Type", "text/html");
          const fixture = serveOnly
            ? html.replace("<head>", '<head><script>localStorage.setItem("gvdg_member_token", "qa-one")</script>')
            : html;
          res.end(await server.transformIndexHtml(req.url, fixture));
          return;
        }
        if (!path.startsWith("/fixture/")) { next(); return; }
        const token = req.headers.authorization?.slice(7);
        const owner = members.get(token);
        function reply(body, status = 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
        if (path === "/fixture/me") { reply({ sub: owner, name: owner, pdgaNo: "123" }); return; }
        if (!path.startsWith("/fixture/me/practice")) { reply({}); return; }
        if (!owner) { reply({ error: "unauthorized" }, 401); return; }
        if (!available) { reply({ error: "outage" }, 503); return; }
        if (path.endsWith("/mutations")) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(body.owner, owner);
          const key = owner + ":" + body.opId;
          if (!operations.has(key)) {
            const revision = body.expectedRevision + 1;
            operations.set(key, { id: body.id, revision });
            if (body.action === "delete") db(owner).delete(body.id);
            else {
              const record = body.kind === "throw" ? { ...body.record, meters: metersFromDistance(body.record.distance, body.record.unit) } : body.record;
              db(owner).set(body.id, { record, id: body.id, revision, kind: body.kind });
            }
            if (loseNextResponse) { loseNextResponse = false; res.destroy(); return; }
          }
          reply(operations.get(key));
          return;
        }
        reply(summary(owner));
      });
    },
  }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
if (serveOnly) {
  console.log("Practice preview: " + origin + "/practice-qa.html#practice");
  await new Promise((resolve) => process.once("SIGTERM", resolve));
  await vite.close();
  process.exit(0);
}
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  await page.addInitScript(() => {
    if (!localStorage.getItem("gvdg_member_token")) localStorage.setItem("gvdg_member_token", "qa-one");
    let count = 0;
    Object.defineProperty(navigator, "geolocation", { value: {
      getCurrentPosition(onSuccess) {
        count += 1;
        onSuccess({ coords: { latitude: 34.85 + count * 0.001, longitude: -82.4, accuracy: 5 } });
      },
    } });
  });
  await page.goto(origin + "/practice-qa.html#play", { waitUntil: "commit" });
  await page.getByRole("button", { name: "My bag", exact: true }).click();
  await page.getByText("Practice record synced.").waitFor();
  await page.getByRole("button", { name: "Add disc" }).click();
  await page.getByLabel("Brand").fill("MVP");
  await page.getByLabel("Model").fill("Wave");
  await page.getByLabel("Plastic").fill("Neutron");
  await page.getByLabel("Weight (g)").fill("172");

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.testQuota = true;
    Storage.prototype.setItem = function (key, value) {
      if (window.testQuota && key.startsWith("gvdg:round-recovery:")) throw new Error("full");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Save disc" }).click();
  await page.getByText("This phone couldn’t save the draft.", { exact: false }).waitFor();
  assert.equal(await page.getByText("Saved on this phone", { exact: false }).count(), 0);
  await page.evaluate(() => { window.testQuota = false; });
  available = false;
  await page.getByRole("button", { name: "Save disc" }).click();
  await page.getByText("1 change saved on this phone.", { exact: false }).waitFor();
  assert.equal(db("qa-one").size, 0);
  await page.reload({ waitUntil: "commit" });
  await page.getByRole("heading", { name: "MVP Wave" }).waitFor();

  await page.evaluate(() => localStorage.setItem("gvdg_member_token", "qa-two"));
  available = true;
  await page.reload({ waitUntil: "commit" });
  await page.getByText("Practice record synced.").waitFor();
  assert.equal(await page.getByRole("heading", { name: "MVP Wave" }).count(), 0);
  assert.equal(db("qa-two").size, 0);

  await page.evaluate(() => localStorage.setItem("gvdg_member_token", "qa-one"));
  loseNextResponse = true;
  await page.reload({ waitUntil: "commit" });
  await page.getByRole("heading", { name: "MVP Wave" }).waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("article.player-card")?.textContent?.includes("Saved on this phone"));
  assert.equal(db("qa-one").size, 1);
  assert.equal(operations.size, 1);

  await page.getByRole("button", { name: "Log a practice session", exact: true }).click();
  await page.getByRole("button", { name: "Log putting", exact: true }).click();
  const first = page.getByRole("group", { name: "Distance 1" });
  await first.getByLabel("Distance", { exact: true }).fill("15");
  await first.getByLabel("Attempts").fill("10");
  await first.getByLabel("Makes").fill("8");
  await page.getByRole("button", { name: "Add another distance" }).click();
  const second = page.getByRole("group", { name: "Distance 2" });
  await second.getByLabel("Distance", { exact: true }).fill("20");
  await second.getByLabel("Attempts").fill("5");
  await second.getByLabel("Makes").fill("1");
  await page.getByRole("button", { name: "Save putting session" }).click();
  await page.getByRole("region", { name: "Putting totals and trends" }).getByText("60% (9/15)", { exact: false }).waitFor();

  await page.getByRole("button", { name: "Fieldwork", exact: true }).click();
  await page.getByRole("button", { name: "Log a measured throw", exact: true }).click();
  await page.getByText("Measure with GPS", { exact: true }).click();
  await page.getByRole("button", { name: "Set throwing spot" }).click();
  await page.getByRole("button", { name: "Set landing spot" }).click();
  const privacy = page.getByRole("checkbox", { name: "Include private GPS locations in this record" });
  assert.equal(await privacy.isChecked(), false);
  await page.getByRole("button", { name: "Save measured throw" }).click();
  await page.getByRole("region", { name: "Measured throw history" }).getByText("MVP Wave", { exact: false }).waitFor();
  await page.getByText("Practice record synced.").waitFor();
  const fieldwork = [...db("qa-one").values()].find((row) => row.kind === "throw");
  assert.ok(fieldwork.record.meters > 100);
  assert.equal(fieldwork.record.origin, undefined);
  console.log("Practice mobile QA passed: quota failure, offline restart, owner isolation, lost acknowledgement, putting totals and private-by-default GPS.");
  await context.close();
} finally {
  await browser.close();
  await vite.close();
}
