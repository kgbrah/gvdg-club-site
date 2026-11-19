import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = "members-app";
const entryImport = /(["'])\.\.\/members-app\.js\1/g;
const VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// gvdg-members.html loads the entry as members-app/members-app.js?v=NNN (bumped on bundle changes). A chunk
// must import the entry by that exact URL, or the browser would load and run a second copy of the app.
function memberEntryQuery() {
  const html = readFileSync(resolve(root, "gvdg-members.html"), "utf8");
  const match = html.match(/<script type="module" src="members-app\/members-app\.js(\?v=\d+)?"><\/script>/);
  if (!match) throw new Error("gvdg-members.html must load members-app/members-app.js as a module script");
  const query = match[1] || "";
  // The head preloads the same URL so the download starts before the body is parsed.
  for (const preload of html.matchAll(/<link rel="modulepreload" href="members-app\/members-app\.js([^"]*)">/g)) {
    if (preload[1] !== query) throw new Error(`gvdg-members.html preloads members-app.js${preload[1]} but loads members-app.js${query}`);
  }
  return query;
}

function encodeVlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest) digit |= 32;
    out += VLQ[digit];
  } while (rest);
  return out;
}

function splitFirstVlq(segment) {
  let value = 0;
  let shift = 0;
  let index = 0;
  for (; index < segment.length; index++) {
    const digit = VLQ.indexOf(segment[index]);
    value += (digit & 31) << shift;
    shift += 5;
    if (!(digit & 32)) break;
  }
  return [value & 1 ? -(value >>> 1) : value >>> 1, segment.slice(index + 1)];
}

// Shift every generated column at or after `column` on one source-map line by `delta`. Only the generated
// column is line-relative; the other fields of each segment are kept as they are.
function shiftMappingLine(line, column, delta) {
  if (!line) return line;
  let absolute = 0;
  let previous = 0;
  return line.split(",").map((segment) => {
    const [first, rest] = splitFirstVlq(segment);
    absolute += first;
    const shifted = absolute >= column ? absolute + delta : absolute;
    const encoded = encodeVlq(shifted - previous) + rest;
    previous = shifted;
    return encoded;
  }).join(",");
}

// Add the entry's ?v= query to a chunk's imports of the entry and keep its source map in step.
function versionEntryImports(code, map, query) {
  const inserts = [...code.matchAll(entryImport)].map((match) => match.index + match[0].length - 1);
  if (!inserts.length) return { code, map };
  const mappingLines = map ? map.mappings.split(";") : [];
  let next = code;
  for (const offset of inserts.reverse()) {
    next = next.slice(0, offset) + query + next.slice(offset);
    if (map) {
      const line = code.slice(0, offset).split("\n").length - 1;
      const column = offset - (code.lastIndexOf("\n", offset - 1) + 1);
      mappingLines[line] = shiftMappingLine(mappingLines[line], column, query.length);
    }
  }
  return { code: next, map: map ? { ...map, mappings: mappingLines.join(";") } : map };
}

// The member app's screens beyond Home load on demand from content-hashed chunks. This plugin
// 1. fails the build if the entry statically imports a chunk (that would add a network round trip
//    before Home can render),
// 2. makes every chunk import the entry with the same ?v= query the page uses, and
// 3. writes members-app/sw-chunks.js, the list sw.js imports to precache every chunk for offline use.
function memberChunkManifest() {
  const entryQuery = memberEntryQuery();
  return {
    name: "gvdg-member-chunk-manifest",
    // The query becomes part of each chunk's content, so it is part of its hash too.
    augmentChunkHash(chunk) {
      return chunk.isEntry ? undefined : entryQuery;
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
      for (const entry of chunks.filter((chunk) => chunk.isEntry)) {
        if (entry.imports.length) {
          this.error(`${entry.fileName} must not statically import other chunks: ${entry.imports.join(", ")}`);
        }
      }
      for (const chunk of chunks.filter((item) => !item.isEntry)) {
        if (!entryQuery || !chunk.imports.includes("members-app.js")) continue;
        const mapAsset = bundle[`${chunk.fileName}.map`];
        const map = mapAsset ? JSON.parse(String(mapAsset.source)) : null;
        const versioned = versionEntryImports(chunk.code, map, entryQuery);
        if (!versioned.code.includes(`members-app.js${entryQuery}"`)) this.error(`${chunk.fileName} does not import members-app.js${entryQuery}`);
        chunk.code = versioned.code;
        if (mapAsset) mapAsset.source = JSON.stringify(versioned.map);
      }
      const files = chunks.filter((chunk) => !chunk.isEntry).map((chunk) => `${outDir}/${chunk.fileName}`).sort();
      this.emitFile({
        type: "asset",
        fileName: "sw-chunks.js",
        source: "// Generated by vite.members.config.mjs. Member app screens that load on demand; sw.js precaches them.\n"
          + `self.GVDG_MEMBER_CHUNKS = ${JSON.stringify(files, null, 2)};\n`,
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [memberChunkManifest()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    // A screen's code and the shared pieces it imports download together (one round, not two) when it opens.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: resolve(root, "src/members-app/main.js"),
      output: {
        entryFileNames: "members-app.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        // Everything Home needs stays in the entry; only screens opened later become chunks.
        codeSplitting: { groups: [{ name: "members-app", tags: ["$initial"] }] },
      },
    },
  },
});
