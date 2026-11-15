import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");

async function navigateOffline(path, entries) {
  const handlers = new Map();
  const origin = "https://gvdgclub.com";
  vm.runInNewContext(source, {
    URL, Response,
    self: { location: { origin }, addEventListener: (name, handler) => handlers.set(name, handler) },
    fetch: async () => { throw new TypeError("Offline"); },
    caches: { match: async (request) => {
      const key = typeof request === "string" ? request : request.url;
      return entries[key] ? new Response(entries[key]) : undefined;
    } },
  });
  let response;
  handlers.get("fetch")({
    clientId: "scoring-phone",
    request: { url: origin + path, method: "GET", mode: "navigate", destination: "document" },
    respondWith(value) { response = value; },
  });
  return (await response)?.text();
}

test("new offline scoring URLs open the scorer shell without a cached query URL", async () => {
  const shells = { "score.html": "Scorer", "gvdg-members.html": "Members" };
  assert.equal(await navigateOffline("/score.html?offline=local-round", shells), "Scorer");
  assert.equal(await navigateOffline("/score.html?offline=1", shells), "Scorer");
  assert.equal(await navigateOffline("/score.html?round=SAVED", {
    ...shells, "https://gvdgclub.com/score.html?round=SAVED": "Cached round",
  }), "Cached round");
  assert.equal(await navigateOffline("/events.html", shells), "Members");
});
