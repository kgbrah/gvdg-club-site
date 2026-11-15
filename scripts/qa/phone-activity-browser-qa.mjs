import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright";

const entry = resolve("scripts/qa/__phone-activity-fixture.js");
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { PhoneActivityPairing } from "../../src/shared/phone-activity-view.js";
const h = React.createElement;
const root = createRoot(document.getElementById("app"));
let owner = "one";
window.fixture = { fail: false, delay: 30, mutations: [], devices: [], tracks: [{id:2,startedAt:1794000000000,distanceM:1420}], earlier:true };
function render() {
  const requestedOwner = owner;
  const api = async (path, options = {}) => {
    const state = window.fixture;
    const method = options.method || "GET";
    await new Promise(resolve => setTimeout(resolve, state.delay));
    if (state.fail) return {ok:false,data:{error:"unavailable"}};
    if (method !== "GET") state.mutations.push({owner:requestedOwner,path,method,body:options.body});
    if (method === "POST") state.devices = [{deviceId:"phone-one",platform:"ios",approvedAt:1794000000000}];
    if (method === "DELETE" && path.includes("pairings")) state.devices = [];
    if (method === "DELETE" && path.includes("tracks")) state.tracks = state.tracks.filter(track => String(track.id) !== path.split("/").pop());
    if (path.endsWith("format=json")) return {ok:true,data:{owner:requestedOwner,points:[{lat:35,lng:-77}]}};
    if (path.includes("before=")) { state.earlier=false; return {ok:true,data:{tracks:[{id:1,startedAt:1793900000000,distanceM:900}],before:null}}; }
    return {ok:true,data:{devices:requestedOwner === "one" ? state.devices : [],tracks:requestedOwner === "one" ? state.tracks : [],before:requestedOwner === "one" && state.earlier ? 2 : null}};
  };
  root.render(h(PhoneActivityPairing, {api,ownerId:owner,showArchive:true}));
}
window.changeOwner = () => { owner = "two"; render(); };
render();`;
const compiled = await build({ configFile: false, logLevel: "silent", plugins: [{ name: "phone-fixture",
  resolveId: (id) => id === entry ? id : null, load: (id) => id === entry ? fixture : null }],
  build: { write: false, rolldownOptions: { input: entry, output: { entryFileNames: "qa.js" } } } });
const assets = new Map(compiled.output.map((file) => ["/" + file.fileName, file.type === "chunk" ? file.code : file.source]));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="phone-activity.css"><style>*{box-sizing:border-box}body{margin:0;padding:16px;font-family:Archivo,sans-serif;background:var(--bg-primary)}#app{max-width:680px;margin:auto}</style></head><body data-member-shell="members"><main id="app"></main><script type="module" src="qa.js"></script></body></html>`;
const mime = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  try {
    response.setHeader("Content-Type", path === "/" ? "text/html" : mime[extname(path)] || "application/octet-stream");
    response.end(path === "/" ? html : assets.get(path) ?? await readFile(resolve("." + path)));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  for (const width of [320, 390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:" + server.address().port);
    if (width === 320) await page.addStyleTag({content:"html{font-size:20px}"});
    await page.getByText("Phone activity · preview", {exact:true}).click();
    await page.getByText("No phones paired yet.", {exact:true}).waitFor();
    await page.getByLabel("Phone activity code").fill("ABCD-EFGH");
    await page.getByRole("button", {name:"Pair phone",exact:true}).click();
    await page.getByText("Phone paired. Open the activity app to connect.").waitFor();
    await page.getByRole("button", {name:/Remove iPhone/}).waitFor();
    assert.equal(await page.evaluate(() => fixture.mutations.filter(row => row.method === "POST").length), 1);
    await page.getByRole("button", {name:"Remove route",exact:true}).first().click();
    await page.getByRole("button", {name:"Keep route",exact:true}).click();
    assert.equal(await page.evaluate(() => fixture.mutations.filter(row => row.path.includes("tracks")).length), 0);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", {name:/Download route recorded/}).first().click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), "gvdg-activity.json");
    const exported = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.equal(exported.owner, "one");
    await page.getByRole("button", {name:"Load earlier routes",exact:true}).click();
    await page.getByText(/900 m recorded/).waitFor();
    await page.evaluate(() => { fixture.fail = true; });
    await page.getByText("Phone activity · preview", {exact:true}).click();
    await page.getByText("Phone activity · preview", {exact:true}).click();
    await page.getByRole("button", {name:"Try loading again",exact:true}).waitFor();
    assert.equal(await page.getByRole("button", {name:/Download route recorded/}).count(), 0);
    await page.evaluate(() => { fixture.fail = false; });
    await page.getByRole("button", {name:"Try loading again",exact:true}).click();
    await page.getByRole("button", {name:/Download route recorded/}).first().waitFor();
    await page.getByRole("button", {name:"Remove route",exact:true}).first().click();
    await page.getByRole("button", {name:"Confirm remove route",exact:true}).click();
    await page.getByText("Route removed from your club account.").waitFor();
    await page.getByRole("button", {name:/Remove iPhone/}).click();
    await page.getByText("No phones paired yet.").waitFor();
    await page.evaluate(() => changeOwner());
    await page.getByText("Phone activity · preview", {exact:true}).click();
    await page.getByText("No activity routes have been uploaded.").waitFor();
    assert.equal(await page.getByRole("button", {name:/Download route recorded/}).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log("PASS phone activity pairing, export, safe cancel/remove, retry and owner isolation at " + width);
    await page.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
