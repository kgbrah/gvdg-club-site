import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const pages = readdirSync(".").filter((name) => name.endsWith(".html") && !name.startsWith("design"));
const styles = readdirSync(".").filter((name) => name.endsWith(".css"));

test("every forest wallpaper declaration offers the WebP before the PNG", () => {
  let declarations = 0;
  for (const file of [...pages, ...styles]) {
    const source = readFileSync(file, "utf8");
    const png = [...source.matchAll(/background(?:-image)?:[^;{}]*url\("img\/bg\/forest-bg\.png"\)[^;{}]*;/g)];
    for (const match of png) {
      if (match[0].includes("image-set(")) continue;
      declarations += 1;
      const next = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
      assert.match(next, /^\s*background-image:[^;]*image-set\(url\("img\/bg\/forest-bg\.webp"\) type\("image\/webp"\), url\("img\/bg\/forest-bg\.png"\) type\("image\/png"\)\)/,
        `${file}: the PNG wallpaper must be followed by its WebP image-set`);
    }
  }
  assert.ok(declarations >= 15, "wallpaper declarations were found");
  assert.ok(existsSync("img/bg/forest-bg.webp"));
});

test("headers use the right-sized logo mark and pages use the small favicon", () => {
  const logo = readFileSync("src/shared/club-logo.js", "utf8");
  assert.match(logo, /CLUB_LOGO_MARK = "img\/logo-mark-117\.png"/);
  assert.match(logo, /"img\/logo-mark-117\.png 1x, img\/logo-mark-117\.png 2x, img\/logo-mark-234\.png 3x"/);
  assert.match(logo, /srcSet: CLUB_LOGO_MARK_SRCSET/);
  assert.match(readFileSync("src/score-app/main.js", "utf8"), /src: CLUB_LOGO_MARK, srcSet: CLUB_LOGO_MARK_SRCSET/);
  for (const file of ["img/logo-mark-117.png", "img/logo-mark-234.png", "img/logo-small.png", "img/logo.png"]) assert.ok(existsSync(file), file);
  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    assert.doesNotMatch(html, /href="img\/logo\.png"/, `${page} favicon`);
  }
  for (const source of ["src/shared/club-logo.js", "src/score-app/main.js"]) {
    assert.doesNotMatch(readFileSync(source, "utf8"), /src: "img\/logo\.png"/, source);
  }
});

test("the worker precaches one logo mark and the small logo, not the full logo or wallpaper", () => {
  const sw = readFileSync("sw.js", "utf8");
  assert.match(sw, /"img\/logo-mark-234\.png"/);
  assert.match(sw, /"img\/logo-small\.png"/);
  assert.doesNotMatch(sw, /"img\/logo\.png"|"img\/logo-mark-117\.png"|forest-bg/);
  const manifest = JSON.parse(readFileSync("site.webmanifest", "utf8"));
  for (const icon of manifest.icons) assert.ok(existsSync(icon.src), icon.src);
});
