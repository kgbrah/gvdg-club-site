import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// The field test recorder keeps a fixed name so sw.js can precache it: a volunteer who turns field
// test mode on and then reloads the scorer in airplane mode must still get the recorder.
const FIXED_CHUNKS = new Map([["field-test-recorder", "field-test-recorder.js"]]);

// score.html loads the entry as score-app/score-app.js?v=NNN. A lazy chunk that imported "./score-app.js"
// would fetch and run a second copy of the scorer, so the build fails instead.
function scoreChunkGuard() {
  return {
    name: "gvdg-score-chunk-guard",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || chunk.isEntry) continue;
        if (chunk.imports.includes("score-app.js")) {
          this.error(`${chunk.fileName} imports score-app.js; keep lazy scorer modules free of entry imports`);
        }
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [scoreChunkGuard()],
  build: {
    outDir: "score-app",
    emptyOutDir: true,
    sourcemap: true,
    modulePreload: false,
    rolldownOptions: {
      input: resolve(root, "src/score-app/main.js"),
      output: {
        entryFileNames: "score-app.js",
        chunkFileNames: (chunk) => FIXED_CHUNKS.get(chunk.name) || "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
