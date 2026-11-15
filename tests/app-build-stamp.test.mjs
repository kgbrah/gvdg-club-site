import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stamp-app-build.mjs", import.meta.url).pathname;
const repository = new URL("../", import.meta.url);

test("every published page identifies its actual release without modifying source files", () => {
  const artifact = mkdtempSync(join(tmpdir(), "gvdg-build-stamp-"));
  const pages = readdirSync(repository).filter((name) => name.endsWith(".html"));
  const originals = new Map(pages.map((name) => [name, readFileSync(new URL(name, repository), "utf8")]));
  for (const [name, html] of originals) writeFileSync(join(artifact, name), html);
  const oldBuild = "a".repeat(40);
  const newBuild = "b".repeat(40);
  for (const build of [oldBuild, newBuild]) {
    execFileSync(process.execPath, [script, artifact, build]);
    for (const [name, original] of originals) {
      const stamped = readFileSync(join(artifact, name), "utf8");
      assert.equal((stamped.match(/name="gvdg-build"/g) || []).length, 1, name);
      assert.ok(stamped.includes('name="gvdg-build" content="' + build + '"'), name);
      assert.ok(stamped.indexOf('name="gvdg-build"') < stamped.indexOf("</head>"), name);
      assert.equal(readFileSync(new URL(name, repository), "utf8"), original, name);
    }
  }
});

test("invalid release markers fail before changing the artifact", () => {
  const artifact = mkdtempSync(join(tmpdir(), "gvdg-invalid-build-"));
  const html = "<html><head></head><body>Keep this page</body></html>";
  writeFileSync(join(artifact, "index.html"), html);
  assert.throws(() => execFileSync(process.execPath, [script, artifact, 'bad\"><script>'], { stdio: "pipe" }));
  assert.equal(readFileSync(join(artifact, "index.html"), "utf8"), html);
});
