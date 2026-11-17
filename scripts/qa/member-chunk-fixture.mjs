// A member-app release fixture served with the REAL sw.js and pwa.js, for update and offline checks of
// lazily loaded screens. Each release has its own content-hashed-style chunk files; a deploy removes the
// previous release's chunks from the server, as Cloudflare/GitHub Pages do.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";

const repo = new URL("../../", import.meta.url);
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json",
  ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

export async function startMemberChunkFixture({ screens = ["stats", "club"], holdInstall = false } = {}) {
  const realWorker = await readFile(new URL("sw.js", repo), "utf8");
  // With `holdInstall` the worker keeps its precache and caching code but waits for the app's SKIP_WAITING
  // message, so an update stays "waiting" the way pwa.js expects on browsers that delay activation.
  const worker = holdInstall ? realWorker.replace("    await self.skipWaiting();\n  })());", "  })());") : realWorker;
  if (holdInstall && worker === realWorker) throw new Error("sw.js install no longer ends with skipWaiting(); update the fixture");
  const registrar = await readFile(new URL("pwa.js", repo));
  const state = { release: "A", online: true, requests: [] };
  const chunk = (screen, release = state.release) => `members-app/chunks/${screen}-${release}.js`;
  const page = (release) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="gvdg-build" content="${release}">
<title>Member chunk fixture</title><script src="/pwa.js" defer></script></head>
<body><main><h1>Member app ${release}</h1><p id="screen">Home</p></main>
<script type="module">
  const files = ${JSON.stringify(Object.fromEntries(screens.map((screen) => [screen, "/" + chunk(screen, release)])))};
  window.openScreen = async (name) => {
    try {
      const module = await import(files[name]);
      document.getElementById("screen").textContent = module.screen;
    } catch (error) {
      document.getElementById("screen").textContent = "failed " + name;
    }
    return document.getElementById("screen").textContent;
  };
</script></body></html>`;

  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    state.requests.push(path);
    const send = (type, body, status = 200) => {
      response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body), Connection: "close" });
      response.end(body);
    };
    if (path === "/sw.js") return send("text/javascript", `${worker}\n// release ${state.release}\n`);
    if (path === "/members-app/sw-chunks.js") {
      return send("text/javascript", `self.GVDG_MEMBER_CHUNKS = ${JSON.stringify(screens.map((screen) => chunk(screen)))};\n`);
    }
    if (path === "/pwa.js") return send("text/javascript", registrar);
    if (path === "/version.json") return send("application/json", JSON.stringify({ commit: state.release }));
    if (path === "/gvdg-members.html") return send("text/html", page(state.release));
    const match = path.match(/^\/members-app\/chunks\/([a-z]+)-([A-Z])\.js$/);
    // Only the deployed release's chunks exist on the server.
    if (match && match[2] === state.release && screens.includes(match[1])) {
      return send("text/javascript", `export const screen = ${JSON.stringify(`${match[1]} ${match[2]}`)};\n`);
    }
    if (match) return send("text/plain", "Missing", 404);
    // The worker's other precached assets come from the repo, so its install completes as it does live.
    const file = new URL("." + decodeURIComponent(path), repo);
    if (!file.href.startsWith(repo.href)) return send("text/plain", "Forbidden", 403);
    readFile(file).then((body) => send(types[extname(path)] || "application/octet-stream", body), () => send("text/plain", "Missing", 404));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    state,
    chunk,
    deploy(release) { state.release = release; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

// The member chunk cache's contents, as paths.
export async function cachedChunks(page) {
  return page.evaluate(async () => {
    const cache = await caches.open("gvdg-member-chunks");
    return (await cache.keys()).map((request) => new URL(request.url).pathname).filter((path) => path.includes("/chunks/")).sort();
  });
}
