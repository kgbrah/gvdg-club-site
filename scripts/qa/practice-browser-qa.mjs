import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { buildTheme } from "../../src/shared/dashboard-theme-model.js";
import { EMPTY_PRACTICE, metersFromDistance, puttingMakeTotals } from "../../src/members-app/practice-model.js";

const members = new Map([["qa-one", "qa-one"], ["qa-two", "qa-two"]]);
const serveOnly = Boolean(process.env.GVDG_PRACTICE_QA_SERVE);
const bagEvidence = process.env.GVDG_BAG_QA_IMAGES;
const blueTheme = buildTheme({ mode: "dark",
  wallpaper: "data:image/jpeg;base64," + (await readFile("img/slide4.jpg")).toString("base64"),
  sourcePalette: ["#112a57", "#b5e64e", "#88c9a3", "#e7cc9b", "#507be1", "#b190d6", "#a7caf4", "#e3eefc",
    "#415876", "#d1f29c", "#c2efcf", "#f5e0b6", "#8cb2ff", "#dbbbef", "#c3e3fe", "#f4f8ff"],
});
const records = new Map();
// My Bag's server extras (/me/bag): photos, lost links and the found-disc switch, per owner.
const bags = new Map();
const QA_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
function bag(owner) {
  if (!bags.has(owner)) bags.set(owner, { matchFound: true, photos: [], lost: [], accessories: [], next: 1, nextAccessory: 1 });
  return bags.get(owner);
}
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
        if (path === "/fixture/me/dashboard-theme" && owner === "bag-390") { reply({ theme: blueTheme }); return; }
        if (path === "/fixture/me/bag" || path.startsWith("/fixture/me/bag/")) {
          if (!owner) { reply({ error: "unauthorized" }, 401); return; }
          const mine = bag(owner);
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
          const photoId = Number(/\/photos\/(\d+)$/.exec(path)?.[1]);
          if (path === "/fixture/me/bag" && req.method === "GET") {
            reply({
              matchFound: mine.matchFound, lost: mine.lost, listings: mine.listings || [],
              photos: mine.photos.filter((photo) => photo.discId).map(({ id, discId }) => ({ id, discId })),
              bagPhotos: mine.photos.filter((photo) => photo.bag).map(({ id }) => ({ id })),
              accessories: mine.accessories.map((item) => ({ ...item, photos: mine.photos.filter((photo) => photo.accessoryId === item.id).map((photo) => photo.id) })),
            });
            return;
          }
          if (path === "/fixture/me/bag/accessories" && req.method === "POST") {
            const item = { id: mine.nextAccessory++, kind: body.kind, name: body.name || "", notes: body.notes || "" };
            mine.accessories.push(item);
            reply({ accessory: { ...item, photos: [] } }, 201);
            return;
          }
          const accessoryId = Number(/\/accessories\/(\d+)$/.exec(path)?.[1]);
          if (accessoryId && req.method === "PATCH") {
            const item = mine.accessories.find((row) => row.id === accessoryId);
            Object.assign(item, body);
            reply({ accessory: item });
            return;
          }
          if (accessoryId && req.method === "DELETE") {
            mine.accessories = mine.accessories.filter((row) => row.id !== accessoryId);
            mine.photos = mine.photos.filter((photo) => photo.accessoryId !== accessoryId);
            reply({ ok: true });
            return;
          }
          if (path === "/fixture/me/bag/settings" && req.method === "PUT") { mine.matchFound = body.matchFound === true; reply({ matchFound: mine.matchFound }); return; }
          if (path === "/fixture/me/bag/photos" && req.method === "POST") {
            assert.match(body.image, /^data:image\/jpeg;base64,/);
            if (body.bag === true) mine.photos.push({ id: mine.next, bag: true });
            else if (body.accessoryId) mine.photos.push({ id: mine.next, accessoryId: body.accessoryId });
            else {
              assert.ok(db(owner).has(body.discId), "photos only for a saved disc");
              mine.photos.push({ id: mine.next, discId: body.discId });
            }
            reply({ photo: { id: mine.next++ } }, 201);
            return;
          }
          if (photoId && req.method === "GET" && mine.photos.some((photo) => photo.id === photoId)) {
            res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" });
            res.end(QA_JPEG);
            return;
          }
          if (photoId && req.method === "DELETE") { mine.photos = mine.photos.filter((photo) => photo.id !== photoId); reply({ ok: true }); return; }
          reply({ error: "not_found" }, 404);
          return;
        }
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

async function bagEntryContext(width, voiceSupported) {
  const owner = "bag-" + width;
  members.set(owner, owner);
  const context = await browser.newContext({
    viewport: { width, height: 844 }, hasTouch: width < 800, isMobile: width < 800, serviceWorkers: "block",
  });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.addInitScript(({ owner, wide, large, voiceSupported }) => {
    localStorage.setItem("gvdg_member_token", owner);
    sessionStorage.setItem("gvdg_member_token", owner);
    localStorage.setItem("theme", wide ? "light" : "dark");
    if (large) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "20px"; }, { once: true });
    // A fake microphone and recorder: voice entry records until Stop, then the Worker transcribes the clip.
    const mock = { starts: 0, deny: false, streams: [] };
    class FakeRecorder {
      static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
      constructor(stream) { this.stream = stream; this.state = "inactive"; }
      start() { mock.starts++; this.state = "recording"; }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: "audio/webm" }) });
          this.onstop?.();
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: voiceSupported ? FakeRecorder : undefined });
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => {
        if (mock.deny) throw new DOMException("denied", "NotAllowedError");
        const track = { stopped: false, stop() { this.stopped = true; } };
        mock.streams.push(track);
        return { getTracks: () => [track] };
      };
    }
    window.bagVoiceMock = mock;
  }, { owner, wide: width >= 800, large: width === 320, voiceSupported });
  page.setDefaultTimeout(15_000);
  return { context, page, owner };
}

async function checkBagEntry(width, voiceSupported) {
  const { context, page, owner } = await bagEntryContext(width, voiceSupported);
  // What the Worker's /voice/disc answers next; a held reply lets the test act while it's transcribing.
  const replies = [];
  await page.route(/\/voice\/disc$/, async (route) => {
    const next = replies.shift() ?? { status: 422, body: { error: "empty_transcript" } };
    if (next.hold) await next.hold;
    await route.fulfill({ status: next.status ?? 200, contentType: "application/json", body: JSON.stringify(next.body) });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function capture(label) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label + " fits");
    if (bagEvidence) await page.screenshot({ path: join(bagEvidence, width + "-" + label + ".png"), animations: "disabled" });
  }
  try {
    await page.goto(origin + "/practice-qa.html#my-bag", { waitUntil: "commit" });
    await page.getByText("Practice record synced.").waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Add disc", exact: true }).click();
    const brand = page.getByRole("combobox", { name: "Brand", exact: true });
    const model = page.getByRole("combobox", { name: "Model", exact: true });
    const plastic = page.getByRole("combobox", { name: "Plastic", exact: true });
    const weight = page.getByLabel("Weight (g)", { exact: true });
    assert.equal(await page.evaluate(() => window.bagVoiceMock.starts), 0);
    await brand.fill("ax");
    await brand.press("ArrowDown");
    await brand.press("Enter");
    assert.equal(await brand.inputValue(), "Axiom");
    await page.getByRole("button", { name: "Show model choices" }).click();
    const models = page.getByRole("listbox", { name: "Model choices" });
    await models.getByRole("option", { name: "Hex", exact: true }).waitFor();
    assert.equal(await models.getByRole("option", { name: "Glitch", exact: true }).count(), 0);
    await capture("model-choices");
    await models.getByRole("option", { name: "Envy", exact: true }).click();
    await plastic.fill("Elec");
    await plastic.press("ArrowDown");
    await plastic.press("Enter");
    assert.equal(await plastic.inputValue(), "Electron");
    await brand.fill("Innova");
    await brand.press("Escape");
    assert.equal(await model.inputValue(), "Envy", "Changing brands preserves the model text");
    assert.equal(await plastic.inputValue(), "Electron", "Changing brands preserves the plastic text");
    await page.getByRole("button", { name: "Show model choices" }).click();
    assert.equal(await models.getByRole("option", { name: "Envy", exact: true }).count(), 0);
    await model.press("Escape");
    const commonWeights = page.getByRole("combobox", { name: "Common weights", exact: true });
    await commonWeights.selectOption("173");
    assert.equal(await weight.inputValue(), "173");
    await commonWeights.press("ArrowDown");
    assert.equal(await weight.inputValue(), "174");
    await brand.fill("North Flight");
    await page.getByRole("option", { name: "Use “North Flight”", exact: true }).click();
    await model.fill("Starling V2");
    await model.press("ArrowDown");
    await model.press("Enter");
    await plastic.fill("Cloud Flex");
    await page.getByRole("option", { name: "Use “Cloud Flex”", exact: true }).click();
    await weight.fill("221");
    assert.equal(await weight.evaluate((input) => input.validity.rangeOverflow), true);
    await page.getByRole("button", { name: "Save disc", exact: true }).click();
    assert.equal(db(owner).size, 0);
    await weight.fill("167.5");
    await page.getByRole("button", { name: "Save disc", exact: true }).click();
    await page.getByRole("heading", { name: "North Flight Starling V2", exact: true }).waitFor();
    await page.getByText("Practice record synced.").waitFor();
    assert.deepEqual([...db(owner).values()][0].record, {
      brand: "North Flight", model: "Starling V2", plastic: "Cloud Flex", weightGrams: 167.5, notes: "", inBag: true, archived: false,
    });

    await page.getByRole("button", { name: "Add disc", exact: true }).click();
    await brand.fill("North");
    await page.getByRole("option", { name: "North Flight", exact: true }).waitFor();
    await brand.press("Escape");
    await brand.fill("");
    await brand.press("Escape");

    if (!voiceSupported) {
      await page.getByText(/Voice entry is unavailable in this browser/).waitFor();
      await capture("typing-fallback");
      assert.deepEqual(errors, []);
      return;
    }
    const start = page.getByRole("button", { name: "Add by voice", exact: true });
    const transcript = page.getByLabel("Voice transcript", { exact: true });
    const notes = page.locator(".bag-disc-form").getByLabel("Notes", { exact: true });
    await notes.fill("Keep this note");
    await page.getByRole("checkbox", { name: "In my bag" }).uncheck();
    await start.click();
    await page.getByText("Listening…", { exact: true }).waitFor();
    // It keeps recording through a pause (it used to stop at the first one); the clock runs to 30 seconds.
    await page.waitForTimeout(2300);
    assert.equal(await page.getByRole("button", { name: "Stop listening" }).count(), 1, "still listening after a pause");
    assert.match(await page.locator(".bag-disc-voice-clock").innerText(), /^0:0[2-3] \/ 0:30$/);
    await capture("listening");
    replies.push({ body: { transcript: "brand North Plastic Labs, model Owl X, plastic Soft Blend, weight 167 grams" } });
    await page.getByRole("button", { name: "Stop listening" }).click();
    await transcript.waitFor();
    await page.locator(".bag-disc-voice-details").getByText("North Plastic Labs", { exact: true }).waitFor();
    await transcript.fill("Innova Star Destroyer, orange, 174.5 grams");
    await page.locator(".bag-disc-voice-details").getByText("Orange", { exact: true }).waitFor();
    await capture("voice-review");
    await page.getByRole("button", { name: "Fill empty fields" }).click();
    assert.equal(await brand.inputValue(), "Innova");
    assert.equal(await model.inputValue(), "Destroyer");
    assert.equal(await plastic.inputValue(), "Star");
    assert.equal(await weight.inputValue(), "174.5");
    assert.equal(await notes.inputValue(), "Keep this note");
    assert.equal(await page.getByRole("checkbox", { name: "In my bag" }).isChecked(), false);
    assert.equal(db(owner).size, 1, "Voice entry does not save");
    await page.getByRole("button", { name: "Save disc", exact: true }).click();
    await page.getByRole("heading", { name: "Innova Destroyer", exact: true }).waitFor();
    await page.getByText("Practice record synced.").waitFor();
    assert.equal(db(owner).size, 2);

    if (width === 390) {
      await page.getByRole("button", { name: "Add disc", exact: true }).click();
      // Microphone refused; nothing heard; then cancel, switching discs and a sign-in change all drop the clip.
      await page.evaluate(() => { window.bagVoiceMock.deny = true; });
      await start.click();
      await page.getByText("Microphone permission was denied.", { exact: false }).waitFor();
      await page.evaluate(() => { window.bagVoiceMock.deny = false; });
      assert.equal(await model.isEditable(), true);
      await start.click();
      await page.getByRole("button", { name: "Stop listening" }).click();
      await page.getByText("No speech was detected.", { exact: false }).waitFor();
      await start.click();
      await page.getByRole("button", { name: "Cancel voice" }).click();
      assert.equal(await transcript.count(), 0);
      assert.equal(await brand.inputValue(), "");
      await start.click();
      await page.getByRole("button", { name: "Edit", exact: true }).first().click();
      assert.equal(await transcript.count(), 0);
      let release;
      replies.push({ hold: new Promise((resolve) => { release = resolve; }), body: { transcript: "Axiom Envy 170 grams" } });
      await start.click();
      await page.getByRole("button", { name: "Stop listening" }).click();
      await page.evaluate(() => localStorage.setItem("gvdg_member_token", "qa-two"));
      release();
      await page.waitForTimeout(400);
      assert.equal(await transcript.count(), 0, "a sign-in change drops the transcript");
      assert(await page.evaluate(() => window.bagVoiceMock.streams.length >= 4 && window.bagVoiceMock.streams.every((track) => track.stopped)),
        "every recording turned the microphone off");

      const sibling = await context.newPage();
      await sibling.goto(origin + "/img/logo.png");
      const editor = page.locator(".bag-disc-form");
      for (const change of ["remove", "replace", "clear"]) {
        await sibling.evaluate((token) => localStorage.setItem("gvdg_member_token", token), owner);
        await page.evaluate((token) => sessionStorage.setItem("gvdg_member_token", token), owner);
        await page.getByRole("button", { name: "Add disc", exact: true }).click();
        await start.click();
        await page.getByText("Listening…", { exact: true }).waitFor();
        await sibling.evaluate((action) => {
          if (action === "replace") localStorage.setItem("gvdg_member_token", "qa-two");
          else if (action === "clear") localStorage.clear();
          else localStorage.removeItem("gvdg_member_token");
        }, change);
        await editor.waitFor({ state: "detached" });
        assert.equal(await transcript.count(), 0);
        assert.equal(await page.evaluate(() => window.bagVoiceMock.streams.at(-1).stopped), true, "signing out elsewhere turns the microphone off");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("gvdg_member_token")), null);
        assert.equal(await sibling.evaluate(() => localStorage.getItem("gvdg_member_token")), change === "replace" ? "qa-two" : null);
      }
      await sibling.close();
      assert.equal(db(owner).size, 2);
    }
    assert.deepEqual(errors, []);
    console.log("Bag choices and voice review verified at " + width);
  } finally {
    await context.close();
  }
}

async function checkPractice() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  await page.getByRole("button", { name: "My bag", exact: true }).waitFor({ state: "visible", timeout: 60000 });
  await page.getByRole("button", { name: "My bag", exact: true }).click();
  await page.getByText("Practice record synced.").waitFor();
  await page.getByRole("button", { name: "Add disc" }).click();
  await page.getByLabel("Brand", { exact: true }).fill("MVP");
  await page.getByLabel("Model", { exact: true }).fill("Wave");
  await page.getByLabel("Plastic", { exact: true }).fill("Neutron");
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
  await checkBagExtras(page);
  assert.deepEqual(pageErrors, [], "Practice must not produce runtime errors");
  console.log("Practice mobile QA passed: quota failure, offline restart, owner isolation, lost acknowledgement, putting totals and private-by-default GPS.");
  await context.close();
}

/** My Bag meets Lost & Found: colour and private writing, private photos, "I lost this disc", and the switch. */
async function checkBagExtras(page) {
  await page.getByRole("button", { name: "My bag", exact: true }).click();
  const card = page.locator("article.player-card").filter({ has: page.getByRole("heading", { name: "MVP Wave" }) });
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: /^Colour/ }).selectOption("Orange");
  await page.getByLabel("What's written on it (private)").fill("QA One 555-0100");
  await page.getByRole("button", { name: "Save disc" }).click();
  await page.getByText("Practice record synced.").waitFor();
  const saved = [...db("qa-one").values()].find((row) => row.kind === "disc");
  assert.equal(saved.record.color, "Orange");
  assert.equal(saved.record.ink, "QA One 555-0100");
  await card.getByText("Orange · Neutron · 172 g", { exact: false }).waitFor();
  // A private photo: picked with the photo picker, uploaded, shown from a private fetch, deleted. The picker button
  // reads "Add photo" where the browser reports no camera and "Choose photo" next to Take photo otherwise (CI's
  // headless browser lists no devices at all, which counts as "may have a camera").
  const picker = card.getByRole("button", { name: /^(Add photo|Choose photo)$/ });
  const chooser = page.waitForEvent("filechooser");
  await picker.click();
  await (await chooser).setFiles({ name: "wave.jpg", mimeType: "image/jpeg", buffer: QA_JPEG });
  await card.locator(".bag-photo-list img").first().waitFor();
  assert.equal(bag("qa-one").photos.length, 1);
  assert.match(await card.locator(".bag-photo-list img").first().getAttribute("src"), /^blob:/, "a private photo is never a public link");
  if (bagEvidence) await card.screenshot({ path: join(bagEvidence, "bag-disc-photo-390.png") });
  await card.getByRole("button", { name: "Delete photo 1 of MVP Wave" }).click();
  await card.locator(".bag-photo-list").waitFor({ state: "detached" });
  assert.equal(bag("qa-one").photos.length, 0);
  await picker.waitFor();
  // Photos of the whole bag, and an accessory with its own photo: added, edited, deleted.
  const whole = page.locator("[data-bag-whole]");
  let pick = page.waitForEvent("filechooser");
  await whole.getByRole("button", { name: /^(Add photo|Choose photo)$/ }).click();
  await (await pick).setFiles({ name: "bag.jpg", mimeType: "image/jpeg", buffer: QA_JPEG });
  await whole.locator(".bag-photo-list img").first().waitFor();
  assert.equal(bag("qa-one").photos.filter((photo) => photo.bag).length, 1);
  const accessories = page.locator("[data-bag-accessories]");
  await accessories.getByText("No accessories yet.").waitFor();
  await accessories.getByRole("button", { name: "Add accessory" }).click();
  await accessories.getByLabel("What is it?").selectOption("towel");
  await accessories.getByLabel("Name (optional)").fill("Club towel");
  await accessories.getByLabel("Notes (optional)").fill("Green, GVDG logo");
  await accessories.getByRole("button", { name: "Add accessory" }).click();
  const towel = accessories.locator("[data-bag-accessory]").filter({ hasText: "Club towel" });
  await towel.getByText("Green, GVDG logo").waitFor();
  pick = page.waitForEvent("filechooser");
  await towel.getByRole("button", { name: /^(Add photo|Choose photo)$/ }).click();
  await (await pick).setFiles({ name: "towel.jpg", mimeType: "image/jpeg", buffer: QA_JPEG });
  await towel.locator(".bag-photo-list img").first().waitFor();
  assert.equal(bag("qa-one").photos.filter((photo) => photo.accessoryId).length, 1);
  if (bagEvidence) await page.locator("[data-bag-accessories]").screenshot({ path: join(bagEvidence, "bag-accessories-390.png") });
  await towel.getByRole("button", { name: "Edit", exact: true }).click();
  await accessories.getByLabel("Name (optional)").fill("Big towel");
  await accessories.getByRole("button", { name: "Save accessory" }).click();
  const renamed = accessories.locator("[data-bag-accessory]").filter({ hasText: "Big towel" });
  await renamed.waitFor();
  await renamed.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete accessory" }).click();
  await accessories.getByText("No accessories yet.").waitFor();
  assert.deepEqual([bag("qa-one").accessories.length, bag("qa-one").photos.filter((photo) => photo.accessoryId).length], [0, 0]);
  // The found-disc check: on by default, saved when turned off.
  const toggle = page.getByRole("checkbox", { name: "Check found discs against my bag" });
  assert.equal(await toggle.isChecked(), true);
  await toggle.uncheck();
  await page.locator("[data-bag-match=off]").waitFor();
  assert.equal(bag("qa-one").matchFound, false);
  await toggle.check();
  await page.locator("[data-bag-match=on]").waitFor();
  // "I lost this disc": the details go to the Lost & Found form through this tab's sessionStorage, not the address.
  await page.route(/lost-found\.html/, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Lost & Found</title>" }));
  await card.getByRole("button", { name: "I lost this disc" }).click();
  await page.waitForURL(/lost-found\.html#new\/lost\?from=bag$/);
  const handoff = await page.evaluate(() => JSON.parse(sessionStorage.getItem("gvdg_lf_bag_handoff") || "null"));
  assert.deepEqual(handoff, { discId: saved.id, brand: "MVP", mold: "Wave", plastic: "Neutron", color: "Orange", weightG: "172", ink: "QA One 555-0100", photos: [] });
  assert.doesNotMatch(page.url(), /555|QA One/, "the private writing never goes in the address");
  await page.unroute(/lost-found\.html/);
  // Reported lost: the card says so and links to the post.
  bag("qa-one").lost = [{ discId: saved.id, postId: 41, status: "open", title: "MVP Neutron Wave" }];
  await page.goto(origin + "/practice-qa.html#my-bag", { waitUntil: "commit" });
  const reported = page.locator("[data-bag-lost=open]");
  await reported.getByText("Reported lost").waitFor();
  assert.equal(await reported.getByRole("link", { name: "View post" }).getAttribute("href"), "lost-found.html#post/41");
  assert.equal(await page.getByRole("button", { name: "I lost this disc" }).count(), 0);
  assert.equal(await card.getByRole("button", { name: "Sell this" }).count(), 0, "a disc reported lost isn't offered for sale");
  bag("qa-one").lost = [];
  // "Sell this": a disc, the whole bag and an accessory each open the marketplace sell form through this tab's
  // sessionStorage, with their photo ids (and never the private writing).
  bag("qa-one").accessories.push({ id: 99, kind: "cart", name: "Zuca all-terrain cart", notes: "Lives in the trunk" });
  const wholePhoto = bag("qa-one").photos.find((photo) => photo.bag).id;
  await page.route(/pro-shop\.html/, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Pro Shop</title>" }));
  // The same URL with a hash doesn't reload by itself; reload (once the first load is done) so My Bag fetches again,
  // then wait for the bag's server extras (the found-disc switch shows once /me/bag has answered).
  const reopen = async () => {
    await page.goto(origin + "/practice-qa.html#my-bag", { waitUntil: "load" });
    await page.reload({ waitUntil: "load" });
    await page.locator("[data-bag-match]").waitFor();
  };
  const sellFrom = async (button) => {
    await reopen();
    await button().click();
    await page.waitForURL(/pro-shop\.html#market\/sell\?from=bag$/);
    return page.evaluate(() => JSON.parse(sessionStorage.getItem("gvdg_market_bag_handoff") || "null"));
  };
  await reopen();
  await card.getByRole("button", { name: "Sell this" }).waitFor();
  if (bagEvidence) await card.screenshot({ path: join(bagEvidence, "bag-disc-actions-390.png") });
  assert.deepEqual(await sellFrom(() => card.getByRole("button", { name: "Sell this" })),
    { ref: "disc:" + saved.id, brand: "MVP", mold: "Wave", plastic: "Neutron", color: "Orange", weightG: "172", photos: [] });
  assert.doesNotMatch(page.url(), /555|QA One|Wave/, "nothing about the disc goes in the address");
  assert.deepEqual(await sellFrom(() => page.locator("[data-bag-whole]").getByRole("button", { name: "Sell my bag" })), { ref: "bag", photos: [wholePhoto] });
  assert.deepEqual(await sellFrom(() => page.locator("[data-bag-accessory='99']").getByRole("button", { name: "Sell this" })),
    { ref: "accessory:99", gearType: "cart", mold: "Zuca all-terrain cart", photos: [] });
  await page.unroute(/pro-shop\.html/);
  // Listed: the card says so and links to the listing instead.
  bag("qa-one").listings = [{ ref: "disc:" + saved.id, listingId: 77, status: "active" }, { ref: "accessory:99", listingId: 78, status: "pending" }];
  await reopen();
  const forSale = card.locator("[data-bag-for-sale]");
  await forSale.getByText("For sale").waitFor();
  assert.equal(await forSale.getByRole("link", { name: "View listing" }).getAttribute("href"), "pro-shop.html#market/listing/77");
  assert.equal(await card.getByRole("button", { name: "Sell this" }).count(), 0);
  await page.locator("[data-bag-accessory='99'] [data-bag-for-sale]").getByText("Sale pending").waitFor();
  await page.locator("[data-bag-whole]").getByRole("button", { name: "Sell my bag" }).waitFor();
  if (bagEvidence) await card.screenshot({ path: join(bagEvidence, "bag-disc-for-sale-390.png") });
  bag("qa-one").listings = [];
  bag("qa-one").accessories = [];
  console.log("My Bag: colour + private writing saved, private photo up/shown/deleted, bag + accessory photos, accessory add/edit/delete, I lost this disc hands off, Sell this hands off a disc / the bag / an accessory and shows For sale, switch saves");
}

try {
  if (!process.env.GVDG_PRACTICE_QA_BAG_ONLY) await checkPractice();
  if (bagEvidence) await mkdir(bagEvidence, { recursive: true });
  await checkBagEntry(390, true);
  await checkBagEntry(320, false);
  await checkBagEntry(1280, true);
} finally {
  await browser.close();
  await vite.close();
}
