import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Stamp the document itself, so an offline page knows which release it loaded
// even when another tab has already observed a newer version.json.
const [directory, commit] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{40}$/.test(commit || "")) {
  throw new Error("Usage: node scripts/stamp-app-build.mjs <artifact-directory> <40-character commit>");
}
const root = resolve(directory);
const files = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".html"));
if (!files.length) throw new Error("No HTML documents found in the deploy artifact");

const documents = await Promise.all(files.map(async (entry) => {
  const path = resolve(root, entry.name);
  const html = await readFile(path, "utf8");
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error("Missing document head: " + entry.name);
  const clean = html.replace(/<meta\b(?=[^>]*\bname\s*=\s*["']gvdg-build["'])[^>]*>\s*/gi, "");
  return { path, html: clean.replace(/(<head(?:\s[^>]*)?>)/i, '$1\n  <meta name="gvdg-build" content="' + commit + '">') };
}));
await Promise.all(documents.map(({ path, html }) => writeFile(path, html)));
console.log("Stamped app build in " + documents.length + " HTML documents.");
