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
  for (const key of ["primary-strong", "secondary", "accent", "green"]) {
    assert.ok(contrastRatio(hexToRgb(theme.tokens[key]), white) >= 4.5, key);
  }
});

test("secondary text tokens meet AA contrast on the theme background", () => {
  for (const name of Object.keys(PRESET_THEMES)) {
    for (const mode of ["dark", "light"]) {
      const theme = buildTheme({ preset: name, mode });
      const surfaces = ["bg-primary", "bg-secondary", "bg-tertiary"].map((key) => hexToRgb(theme.tokens[key]));
      for (const bg of surfaces) {
        assert.ok(contrastRatio(hexToRgb(theme.tokens["text-primary"]), bg) >= 4.5, `${name} ${mode} text-primary`);
        assert.ok(contrastRatio(hexToRgb(theme.tokens["text-secondary"]), bg) >= 4.5, `${name} ${mode} text-secondary`);
        assert.ok(contrastRatio(hexToRgb(theme.tokens["text-muted"]), bg) >= 4.5, `${name} ${mode} text-muted`);
        assert.ok(contrastRatio(hexToRgb(theme.tokens.primary), bg) >= 4.5, `${name} ${mode} primary`);
      }
    }
  }
});

test("light paper stays light and dark paper stays dark", () => {
  for (const name of Object.keys(PRESET_THEMES)) {
    const dark = buildTheme({ preset: name, mode: "dark" });
    const light = buildTheme({ preset: name, mode: "light" });
    assert.ok(relativeLuminance(hexToRgb(light.tokens["bg-primary"])) >= 0.85, `${name} light paper`);
    assert.ok(relativeLuminance(hexToRgb(dark.tokens["bg-primary"])) <= 0.08, `${name} dark paper`);
    assert.ok(relativeLuminance(hexToRgb(light.tokens["text-primary"])) < 0.32, `${name} light ink`);
    assert.ok(relativeLuminance(hexToRgb(dark.tokens["text-primary"])) > 0.6, `${name} dark ink`);
  }
});

test("wallpaper scrim uses the theme paper so body text is not bleached", () => {
  const wallpaper = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=";
  const props = new Map();
  const root = {
    style: {
      setProperty(name, value) { props.set(name, value); },
      removeProperty(name) { props.delete(name); },
    },
    classList: { add() {}, remove() {} },
  };
  const theme = buildTheme({ preset: "Nord", mode: "light", wallpaper });
  applyDashboardTheme(theme, root);
  const bg = hexToRgb(theme.tokens["bg-primary"]);
  assert.match(props.get("--player-theme-image"), new RegExp(`rgba\\(${bg.r}, ${bg.g}, ${bg.b}, 0\\.86\\)`));
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

test("applyDashboardTheme paints the page body so the public forest footer is covered", () => {
  function fakeEl() {
    const props = new Map();
    const classes = new Set();
    return {
      props,
      classes,
      style: {
        setProperty(name, value) { props.set(name, value); },
        removeProperty(name) { props.delete(name); },
      },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
      },
    };
  }
  const wallpaper = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=";
  const body = fakeEl();
  const root = fakeEl();
  root.ownerDocument = { body };
  const themed = buildTheme({ preset: "Nord", mode: "light", wallpaper });
  applyDashboardTheme(themed, root);
  assert.equal(root.props.get("--primary"), themed.tokens.primary);
  assert.equal(body.props.get("--bg-primary"), themed.tokens["bg-primary"]);
  assert.equal(body.props.get("--text-primary"), themed.tokens["text-primary"]);
  assert.equal(body.props.get("--player-theme-footer"), themed.tokens["text-muted"]);
  assert.equal(body.props.get("--player-theme-link"), themed.tokens.primary);
  assert.equal(body.props.has("--primary"), false);
  assert.equal(body.props.has("--accent"), false);
  assert.equal(body.props.has("--secondary"), false);
  assert.match(body.props.get("--player-theme-image"), /url\("data:image\/png/);
  assert.deepEqual([...root.classes], ["player-theme-active"]);
  assert.ok(body.classes.has("player-theme-page"));
  assert.ok(body.classes.has("player-theme-active"));
  const paperOnly = buildTheme({ preset: "Nord", mode: "light" });
  applyDashboardTheme(paperOnly, root);
  assert.equal(body.props.has("--player-theme-image"), false);
  assert.ok(body.classes.has("player-theme-page"));
  assert.equal(body.classes.has("player-theme-active"), false);
  applyDashboardTheme(null, root);
  assert.equal(root.props.size, 0);
  assert.equal(body.props.size, 0);
  assert.equal(root.classes.size, 0);
  assert.equal(body.classes.size, 0);
});

test("applyDashboardTheme treats a body root as the page", () => {
  function fakeEl() {
    const props = new Map();
    const classes = new Set();
    return {
      props,
      classes,
      style: {
        setProperty(name, value) { props.set(name, value); },
        removeProperty(name) { props.delete(name); },
      },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
      },
    };
  }
  const wallpaper = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=";
  const body = fakeEl();
  const themed = buildTheme({ preset: "Nord", mode: "light", wallpaper });
  applyDashboardTheme(themed, body);
  assert.equal(body.props.get("--primary"), themed.tokens.primary);
  assert.match(body.props.get("--player-theme-image"), /url\("data:image\/png/);
  assert.ok(body.classes.has("player-theme-page"));
  assert.ok(body.classes.has("player-theme-active"));
  applyDashboardTheme(null, body);
  assert.equal(body.props.size, 0);
  assert.equal(body.classes.size, 0);
});

test("applyDashboardTheme sets and clears CSS variables on the dashboard root", () => {
  const props = new Map();
  const classes = new Set();
  const root = {
    style: {
      setProperty(name, value) { props.set(name, value); },
      removeProperty(name) { props.delete(name); },
    },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
    },
  };
  const theme = buildTheme({ pixels: forestPixels(), mode: "dark", extractMode: "normal", wallpaper: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=" });
  applyDashboardTheme(theme, root);
  assert.equal(props.get("--primary"), theme.tokens.primary);
  assert.match(props.get("--player-theme-image"), /url\("data:image\/png/);
  assert.ok(classes.has("player-theme-active"));
  assert.ok(classes.has("player-theme-page"));
  applyDashboardTheme(null, root);
  assert.equal(props.size, 0);
  assert.equal(classes.size, 0);
  assert.equal(rgbToHex(rgb(255, 0, 8)), "#ff0008");
});

test("sanitizeTheme rebuilds incompatible stored surfaces so ink stays readable", () => {
  const palette = PRESET_THEMES["Gruvbox Dark"].map((hex) => hex.toLowerCase());
  const stored = {
    mode: "dark",
    preset: "Gruvbox Dark",
    palette,
    tokens: {
      primary: "#cc241d",
      "primary-strong": "#9a1b16",
      secondary: "#458588",
      accent: "#d79921",
      green: "#98971a",
      "bg-primary": "#282828",
      "bg-secondary": "#3c3836",
      "bg-tertiary": "#928374",
      "border-color": "#504945",
      "text-primary": "#ebdbb2",
      "text-secondary": "#d5c4a1",
      "text-tertiary": "#bdae93",
      "text-muted": "#a89984",
      "secondary-text": "#689d6a",
    },
  };
  const safe = sanitizeTheme(stored);
  const surfaces = ["bg-primary", "bg-secondary", "bg-tertiary"].map((key) => hexToRgb(safe.tokens[key]));
  for (const bg of surfaces) {
    assert.ok(contrastRatio(hexToRgb(safe.tokens["text-primary"]), bg) >= 4.5, `text-primary on ${rgbToHex(bg)}`);
    assert.ok(contrastRatio(hexToRgb(safe.tokens["text-muted"]), bg) >= 4.5, `text-muted on ${rgbToHex(bg)}`);
  }
  assert.notEqual(safe.tokens["bg-tertiary"], "#928374");
  assert.ok(relativeLuminance(hexToRgb(safe.tokens["bg-primary"])) <= 0.08);
});

test("sanitizeTheme migrates tokens-only themes whose surfaces cannot share ink", () => {
  const safe = sanitizeTheme({
    mode: "dark",
    tokens: {
      primary: "#cc241d",
      "primary-strong": "#9a1b16",
      secondary: "#458588",
      accent: "#d79921",
      green: "#98971a",
      "bg-primary": "#282828",
      "bg-secondary": "#3c3836",
      "bg-tertiary": "#928374",
      "border-color": "#504945",
      "text-primary": "#ebdbb2",
      "text-secondary": "#d5c4a1",
      "text-tertiary": "#bdae93",
      "text-muted": "#a89984",
      "secondary-text": "#689d6a",
    },
  });
  assert.ok(safe);
  assert.ok(contrastRatio(hexToRgb(safe.tokens["text-primary"]), hexToRgb(safe.tokens["bg-primary"])) >= 4.5);
  assert.ok(contrastRatio(hexToRgb(safe.tokens["text-primary"]), hexToRgb(safe.tokens["bg-tertiary"])) >= 4.5);
  assert.notEqual(safe.tokens["bg-tertiary"], "#928374");
});
