import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
const origin = "https://gvdgclub.com";

function fakeResponse(body, contentType = "text/javascript") {
  return {
    ok: true, status: 200, type: "basic", body,
    headers: new Map([["content-type", contentType]]),
    clone() { return fakeResponse(body, contentType); },
    async text() { return body; },
  };
}

// A Cache Storage stand-in shared by successive service-worker versions, like the browser's.
function fakeCaches() {
  const stores = new Map();
  const keyOf = (request) => new URL(typeof request === "string" ? request : request.url, origin + "/").href;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async match(request) { return store.get(keyOf(request))?.clone(); },
      async put(request, response) { store.set(keyOf(request), response); },
      async keys() { return [...store.keys()].map((url) => ({ url })); },
      async delete(request) { return store.delete(keyOf(request)); },
    };
  };
  return {
    stores, open,
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const store of stores.values()) {
        const hit = store.get(keyOf(request));
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
}

// Load sw.js as one deployed version whose build listed `chunks`.
function worker(caches, chunks, { network, now, publicChunks = [] }) {
  const handlers = new Map();
  const fetched = [];
  const self = {
    location: { origin, href: origin + "/sw.js" },
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(source, {
    URL, Response, self, caches,
    Date: Object.assign(class extends Date {}, { now: () => now }),
    importScripts: (path) => {
      if (path === "members-app/sw-chunks.js") {
        self.GVDG_MEMBER_CHUNKS = chunks;
      } else if (path === "public-app/sw-chunks.js") {
        self.GVDG_PUBLIC_CHUNKS = publicChunks;
      } else {
        throw new Error(`unexpected chunk script: ${path}`);
      }
    },
    fetch: async (request) => {
      const url = new URL(typeof request === "string" ? request : request.url, origin + "/").href;
      fetched.push(url);
      if (!network.online) throw new TypeError("Offline");
      if (!network.files.has(url)) return { ok: false, status: 404, type: "basic", headers: new Map(), clone() { return this; } };
      const file = network.files.get(url);
      // Cloudflare Pages answers a file it doesn't have with the site's HTML and a 200.
      return typeof file === "object" ? fakeResponse(file.body, file.type) : fakeResponse(file);
    },
  });
  async function lifecycle(name) {
    let pending;
    handlers.get(name)({ waitUntil: (promise) => { pending = promise; } });
    await pending;
  }
  return {
    fetched,
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    async get(path) {
      let response;
      handlers.get("fetch")({
        clientId: "member-app",
        request: { url: origin + "/" + path, method: "GET", mode: "cors", destination: "script" },
        respondWith(value) { response = value; },
      });
      return response;
    },
  };
}

const chunk = (name) => `members-app/chunks/${name}.js`;
const url = (path) => `${origin}/${path}`;

test("the worker precaches the build's member chunks and keeps the previous version's after an update", async () => {
  const caches = fakeCaches();
  const network = { online: true, files: new Map() };
  const deploy = (names) => {
    network.files = new Map(names.map((name) => [url(chunk(name)), `chunk ${name}`]));
    return names.map(chunk);
  };

  const listA = deploy(["season-A1", "shared-S1"]);
  const a = worker(caches, listA, { network, now: 1000 });
  await a.install();
  await a.activate();
  const chunkStore = () => [...caches.stores.get("gvdg-member-chunks").keys()].filter((key) => key.includes("/chunks/")).sort();
  assert.deepEqual(chunkStore(), [url(chunk("season-A1")), url(chunk("shared-S1"))]);

  // Version B ships a new season chunk; the unchanged shared chunk is not downloaded again.
  const listB = deploy(["season-B1", "shared-S1"]);
  const b = worker(caches, listB, { network, now: 2000 });
  await b.install();
  assert.deepEqual(b.fetched.filter((href) => href.includes("/chunks/")), [url(chunk("season-B1"))]);
  await b.activate();
  assert.deepEqual(chunkStore(), [url(chunk("season-A1")), url(chunk("season-B1")), url(chunk("shared-S1"))]);

  // A page still running version A opens Stats after the update: its chunk is gone from the server
  // and the phone is offline, but the worker still has it.
  network.online = false;
  assert.equal(await (await b.get(chunk("season-A1"))).text(), "chunk season-A1");
  network.online = true;
  assert.equal(await (await b.get(chunk("season-A1"))).text(), "chunk season-A1");

  // Version C: only the current and previous versions' chunks are kept.
  const listC = deploy(["season-C1"]);
  const c = worker(caches, listC, { network, now: 3000 });
  await c.install();
  await c.activate();
  assert.deepEqual(chunkStore(), [url(chunk("season-B1")), url(chunk("season-C1")), url(chunk("shared-S1"))]);
  const manifests = [...caches.stores.get("gvdg-member-chunks").keys()].filter((key) => key.includes("member-chunk-manifest/"));
  assert.equal(manifests.length, 2);
});

test("a chunk missing from the cache is fetched once and kept", async () => {
  const caches = fakeCaches();
  const network = { online: true, files: new Map([[url(chunk("late-L1")), "chunk late-L1"]]) };
  const sw = worker(caches, [], { network, now: 1000 });
  await sw.install();
  await sw.activate();
  assert.equal(await (await sw.get(chunk("late-L1"))).text(), "chunk late-L1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  network.online = false;
  assert.equal(await (await sw.get(chunk("late-L1"))).text(), "chunk late-L1");
});

test("the site's HTML answered for a missing script is never saved as that script", async () => {
  const caches = fakeCaches();
  const html = { body: "<!DOCTYPE html><title>GVDG</title>", type: "text/html; charset=utf-8" };
  const network = { online: true, files: new Map([[url(chunk("account-X1")), html]]) };
  // Mid-deploy: the worker precaches a chunk the server answers with the HTML page.
  const sw = worker(caches, [chunk("account-X1")], { network, now: 1000 });
  await sw.install();
  await sw.activate();
  const saved = () => [...caches.stores.get("gvdg-member-chunks").keys()].filter((key) => key.includes("/chunks/"));
  assert.deepEqual(saved(), [], "the HTML answer isn't kept");
  // The real file arrives: the screen gets it, and it's kept.
  network.files.set(url(chunk("account-X1")), "chunk account-X1");
  assert.equal(await (await sw.get(chunk("account-X1"))).text(), "chunk account-X1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved(), [url(chunk("account-X1"))]);
});

test("a bad copy already saved (from an older worker) is thrown out and fetched again", async () => {
  const caches = fakeCaches();
  const network = { online: true, files: new Map([[url(chunk("account-X1")), "chunk account-X1"]]) };
  // The phone holds the HTML page under the chunk's name (what the older worker saved mid-deploy).
  const chunkCache = await caches.open("gvdg-member-chunks");
  await chunkCache.put(url(chunk("account-X1")), fakeResponse("<!DOCTYPE html>", "text/html"));
  const sw = worker(caches, [chunk("account-X1")], { network, now: 1000 });
  await sw.install();
  await sw.activate();
  assert.equal(await (await sw.get(chunk("account-X1"))).text(), "chunk account-X1");
  network.online = false;
  assert.equal(await (await sw.get(chunk("account-X1"))).text(), "chunk account-X1", "the real file was saved in its place");
});

test("the members build lists every chunk for the worker and chunks import the page's entry URL", () => {
  const html = readFileSync("gvdg-members.html", "utf8");
  const entryQuery = html.match(/<script type="module" src="members-app\/members-app\.js(\?v=\d+)"><\/script>/)?.[1];
  assert.ok(entryQuery, "the page loads the entry with a ?v= query");
  assert.match(html, new RegExp(`<link rel="modulepreload" href="members-app/members-app\\.js\\${entryQuery}">`));
  const manifest = readFileSync("members-app/sw-chunks.js", "utf8");
  const listed = JSON.parse(manifest.slice(manifest.indexOf("["), manifest.lastIndexOf("]") + 1));
  const files = readdirSync("members-app/chunks").filter((name) => name.endsWith(".js")).map((name) => `members-app/chunks/${name}`).sort();
  assert.deepEqual(listed, files);
  assert.ok(files.length > 0);
  const entry = readFileSync("members-app/members-app.js", "utf8");
  assert.doesNotMatch(entry, /^import[^;]*from"\.\/chunks\//m, "the entry must not wait on another file before Home renders");
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/from"\.\.\/members-app\.js([^"]*)"/g)) {
      assert.equal(match[1], entryQuery, `${file} must import the entry exactly as the page loads it`);
    }
  }
  const sw = readFileSync("sw.js", "utf8");
  assert.match(sw, /importScripts\("members-app\/sw-chunks\.js"\)/);
  assert.match(sw, /"members-app\/members-app\.js"/);
});
