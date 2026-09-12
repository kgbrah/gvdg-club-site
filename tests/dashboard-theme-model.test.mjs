import assert from "node:assert/strict";
import test from "node:test";

import {
  PRESET_THEMES,
  TOKEN_KEYS,
  applyAdjustments,
  applyDashboardTheme,
  applyExtractMode,
  buildTheme,
  contrastRatio,
  hexToRgb,
  medianCut,
  normalizeExtractMode,
  paletteFromPixels,
  relativeLuminance,
  rgb,
  rgbToHex,
  rgbToOklch,
  sanitizeTheme,
  tokensFromPalette,
  writeStoredTheme,
} from "../src/shared/dashboard-theme-model.js";

function forestPixels() {
  const pixels = [];
  for (let i = 0; i < 40; i += 1) pixels.push(rgb(12, 28, 18));
  for (let i = 0; i < 40; i += 1) pixels.push(rgb(34, 72, 40));
  for (let i = 0; i < 30; i += 1) pixels.push(rgb(210, 120, 48));
  for (let i = 0; i < 20; i += 1) pixels.push(rgb(240, 236, 220));
  for (let i = 0; i < 20; i += 1) pixels.push(rgb(48, 92, 140));
  return pixels;
}

function meanChroma(palette) {
  const chromas = palette.map((hex) => rgbToOklch(hexToRgb(hex)).c);
  return chromas.reduce((sum, value) => sum + value, 0) / chromas.length;
}

function hueDistance(a, b) {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

test("medianCut reduces a mixed pixel set to a compact palette", () => {
  const palette = medianCut(forestPixels(), 8);
  assert.equal(palette.length, 8);
  assert.ok(palette.every((color) => color.r >= 0 && color.r <= 255));
});

test("tokensFromPalette keeps readable text on the generated background", () => {
  const palette = paletteFromPixels(forestPixels(), "normal", "dark");
  const dark = tokensFromPalette(palette, "dark");
  const light = tokensFromPalette(paletteFromPixels(forestPixels(), "normal", "light"), "light");
  assert.ok(dark && light);
  for (const key of TOKEN_KEYS) {
    assert.match(dark[key], /^#[0-9a-f]{6}$/);
    assert.match(light[key], /^#[0-9a-f]{6}$/);
  }
  assert.ok(contrastRatio(hexToRgb(dark["text-primary"]), hexToRgb(dark["bg-primary"])) >= 4.5);
  assert.ok(contrastRatio(hexToRgb(light["text-primary"]), hexToRgb(light["bg-primary"])) >= 4.5);
  assert.notEqual(dark["bg-primary"], light["bg-primary"]);
});

test("extract modes each emit a 16-color palette", () => {
  for (const extractMode of ["normal", "muted", "colorful", "pastel", "monochromatic", "analogous", "material", "forest"]) {
    const palette = paletteFromPixels(forestPixels(), extractMode, "dark");
    assert.equal(palette.length, 16, extractMode);
    assert.ok(palette.every((hex) => /^#[0-9a-f]{6}$/.test(hex)), extractMode);
  }
  const muted = paletteFromPixels(forestPixels(), "muted", "dark");
  const colorful = paletteFromPixels(forestPixels(), "colorful", "dark");
  assert.ok(meanChroma(colorful) > meanChroma(muted));
  assert.equal(normalizeExtractMode("mono"), "monochromatic");
  const orange = rgb(210, 90, 30);
  const mutedColor = applyExtractMode(orange, "muted");
  const colorfulColor = applyExtractMode(orange, "colorful");
  assert.ok(Math.max(mutedColor.r, mutedColor.g, mutedColor.b) - Math.min(mutedColor.r, mutedColor.g, mutedColor.b)
    < Math.max(colorfulColor.r, colorfulColor.g, colorfulColor.b) - Math.min(colorfulColor.r, colorfulColor.g, colorfulColor.b));
});

test("analogous extraction stays near the wallpaper's dominant hue", () => {
  const palette = paletteFromPixels(forestPixels(), "analogous", "dark");
  const hues = palette.slice(1, 7).map((hex) => rgbToOklch(hexToRgb(hex)).h);
  const span = Math.max(...hues.map((hue) => hueDistance(hue, hues[0])));
  assert.ok(span <= 62, `analogous span ${span}`);
});

test("Nord preset maps ANSI slot 0 onto the dashboard background", () => {
  const theme = buildTheme({ preset: "Nord", mode: "dark" });
  assert.equal(theme.palette.length, 16);
  assert.equal(theme.tokens["bg-primary"], PRESET_THEMES.Nord[0].toLowerCase());
  const white = rgb(255, 255, 255);
  assert.ok(contrastRatio(hexToRgb(theme.tokens.green), white) >= 4.5);
  const light = buildTheme({ preset: "Nord", mode: "light" });
  assert.notEqual(light.tokens["bg-primary"], theme.tokens["bg-primary"]);
});

test("fill tokens stay readable on white tile text", () => {
  const theme = buildTheme({ preset: "Dracula", mode: "dark" });
  const white = rgb(255, 255, 255);
  for (const key of ["primary", "secondary", "accent", "green"]) {
    assert.ok(contrastRatio(hexToRgb(theme.tokens[key]), white) >= 4.5, key);
  }
});

test("secondary text tokens meet AA contrast on the theme background", () => {
  for (const name of Object.keys(PRESET_THEMES)) {
    for (const mode of ["dark", "light"]) {
      const theme = buildTheme({ preset: name, mode });
      const bg = hexToRgb(theme.tokens["bg-primary"]);
      assert.ok(contrastRatio(hexToRgb(theme.tokens["text-secondary"]), bg) >= 4.5, `${name} ${mode} text-secondary`);
      assert.ok(contrastRatio(hexToRgb(theme.tokens["text-muted"]), bg) >= 4.5, `${name} ${mode} text-muted`);
    }
  }
});

test("recolored palettes swap anchors when switching to light", () => {
  const dark = buildTheme({ preset: "Nord", mode: "dark" });
  const source = dark.sourcePalette.slice();
  source[2] = "#112233";
  const light = buildTheme({ sourcePalette: source, mode: "light" });
  assert.equal(light.preset, null);
  assert.ok(
    relativeLuminance(hexToRgb(light.tokens["bg-primary"]))
      > relativeLuminance(hexToRgb(dark.tokens["bg-primary"])),
  );
  const restored = buildTheme({ sourcePalette: light.sourcePalette, mode: "dark" });
  assert.ok(
    relativeLuminance(hexToRgb(restored.tokens["bg-primary"]))
      < relativeLuminance(hexToRgb(light.tokens["bg-primary"])),
  );
});

test("adjustments keep a manually recolored source palette", () => {
  const source = PRESET_THEMES.Nord.map((hex) => hex.toLowerCase());
  source[2] = "#112233";
  const next = buildTheme({ sourcePalette: source, mode: "dark", adjustments: { vibrance: 20 } });
  assert.equal(next.sourcePalette[2], "#112233");
  assert.notEqual(next.palette[2], "#112233");
});

test("writeStoredTheme swallows quota errors so callers can still persist remotely", () => {
  const palette = paletteFromPixels(forestPixels(), "normal", "dark");
  const theme = buildTheme({ pixels: forestPixels(), mode: "dark", extractMode: "normal" });
  const storage = {
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() { throw new Error("QuotaExceededError"); },
  };
  assert.equal(writeStoredTheme(storage, "member-a", theme).palette.length, 16);
  assert.equal(palette.length, 16);
});

test("adjustments can boost vibrance without dropping the palette", () => {
  const source = paletteFromPixels(forestPixels(), "muted", "dark");
  const vivid = applyAdjustments(source, { vibrance: 40, saturation: 20 });
  assert.equal(vivid.length, 16);
  assert.ok(meanChroma(vivid) > meanChroma(source));
});

test("sanitizeTheme drops unknown keys, bad hex, and oversize wallpapers", () => {
  const palette = paletteFromPixels(forestPixels(), "normal", "dark");
  const tokens = tokensFromPalette(palette, "dark");
  const safe = sanitizeTheme({
    mode: "dark",
    extractMode: "mono",
    palette,
    tokens: { ...tokens, hacked: "#ff0000" },
    wallpaper: "javascript:alert(1)",
    adjustments: { vibrance: 999, gamma: 0.2 },
  });
  assert.equal(safe.extractMode, "monochromatic");
  assert.equal(safe.wallpaper, null);
  assert.equal(safe.tokens.hacked, undefined);
  assert.equal(safe.adjustments.vibrance, 50);
  assert.equal(safe.adjustments.gamma, 0.5);
  assert.equal(sanitizeTheme({ tokens: { primary: "red" } }), null);
});

test("buildTheme wires wallpaper, mode, and tokens together", () => {
  const wallpaper = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=";
  const theme = buildTheme({ pixels: forestPixels(), mode: "dark", extractMode: "muted", wallpaper });
  assert.equal(theme.mode, "dark");
  assert.equal(theme.extractMode, "muted");
  assert.equal(theme.wallpaper, wallpaper);
  assert.equal(theme.palette.length, 16);
});

test("applyDashboardTheme sets and clears CSS variables on the dashboard root", () => {
  const props = new Map();
  const root = {
    style: {
      setProperty(name, value) { props.set(name, value); },
      removeProperty(name) { props.delete(name); },
    },
    classList: {
      add(name) { root.className = name; },
      remove() { root.className = ""; },
    },
    className: "",
  };
  const theme = buildTheme({ pixels: forestPixels(), mode: "dark", extractMode: "normal", wallpaper: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=" });
  applyDashboardTheme(theme, root);
  assert.equal(props.get("--primary"), theme.tokens.primary);
  assert.match(props.get("--player-theme-image"), /url\("data:image\/png/);
  assert.equal(root.className, "player-theme-active");
  applyDashboardTheme(null, root);
  assert.equal(props.size, 0);
  assert.equal(root.className, "");
  assert.equal(rgbToHex(rgb(255, 0, 8)), "#ff0008");
});
