import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GLASS,
  GLASS_PRESETS,
  applyDashboardTheme,
  buildTheme,
  clampGlassValue,
  glassCssVars,
  glassIsOn,
  glassPresetFor,
  sanitizeGlass,
  sanitizeRemoteTheme,
  sanitizeTheme,
} from "../src/shared/dashboard-theme-model.js";

const SOURCE = ["#101a14", "#c0392b", "#2e8b57", "#d4a017", "#2c6fbb", "#8e44ad", "#1abc9c", "#e8efe9"];

function fakeEl() {
  const props = new Map();
  const classes = new Set();
  return {
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
      getPropertyValue: (k) => props.get(k) || "",
    },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
  };
}

test("glass defaults to off", () => {
  assert.deepEqual(DEFAULT_GLASS, { opacity: 0, blur: 0 });
  assert.deepEqual(sanitizeGlass(undefined), { opacity: 0, blur: 0 });
  assert.equal(glassIsOn(DEFAULT_GLASS), false);
});

test("glass values clamp and round", () => {
  assert.equal(clampGlassValue("opacity", 999), 60);
  assert.equal(clampGlassValue("opacity", -4), 0);
  assert.equal(clampGlassValue("blur", 30), 24);
  assert.equal(clampGlassValue("blur", 7.6), 8);
  assert.deepEqual(sanitizeGlass({ opacity: "x", blur: NaN }), { opacity: 0, blur: 0 });
  assert.deepEqual(sanitizeGlass("junk"), { opacity: 0, blur: 0 });
});

test("preset values and detection", () => {
  assert.deepEqual([GLASS_PRESETS.off.opacity, GLASS_PRESETS.off.blur], [0, 0]);
  assert.deepEqual([GLASS_PRESETS.frosted.opacity, GLASS_PRESETS.frosted.blur], [45, 20]);
  assert.deepEqual([GLASS_PRESETS.clear.opacity, GLASS_PRESETS.clear.blur], [60, 10]);
  assert.equal(glassPresetFor({ opacity: 45, blur: 20 }), "frosted");
  assert.equal(glassPresetFor({ opacity: 30, blur: 16 }), "custom");
  assert.equal(glassPresetFor({ opacity: 46, blur: 20 }), "custom");
  assert.equal(glassPresetFor(undefined), "off");
});

test("css variables", () => {
  assert.deepEqual(glassCssVars({ opacity: 35, blur: 16 }), { "--glass-alpha": "35%", "--glass-blur": "16px" });
});

test("built and old themes carry glass", () => {
  const built = buildTheme({ sourcePalette: SOURCE, glass: { opacity: 30, blur: 16 } });
  assert.deepEqual(built.glass, { opacity: 30, blur: 16 });
  assert.deepEqual(buildTheme({ sourcePalette: SOURCE }).glass, { opacity: 0, blur: 0 });
  const { glass: _glass, ...old } = built;
  assert.deepEqual(sanitizeTheme(old).glass, { opacity: 0, blur: 0 });
  assert.deepEqual(sanitizeTheme({ ...old, glass: { opacity: 80, blur: -1 } }).glass, { opacity: 60, blur: 0 });
});

test("remote theme without glass keeps local glass", () => {
  const built = buildTheme({ sourcePalette: SOURCE });
  const { glass: _glass, ...noGlass } = built;
  assert.deepEqual(sanitizeRemoteTheme(noGlass, { opacity: 30, blur: 16 }).glass, { opacity: 30, blur: 16 });
  assert.deepEqual(
    sanitizeRemoteTheme({ ...noGlass, glass: { opacity: 10, blur: 4 } }, { opacity: 30, blur: 16 }).glass,
    { opacity: 10, blur: 4 },
  );
  assert.equal(sanitizeRemoteTheme(null, { opacity: 30, blur: 16 }), null);
});

test("applyDashboardTheme toggles the glass class and variables", () => {
  const el = fakeEl();
  applyDashboardTheme(buildTheme({ sourcePalette: SOURCE, glass: { opacity: 30, blur: 16 } }), el);
  assert.equal(el.style.getPropertyValue("--glass-alpha"), "30%");
  assert.equal(el.style.getPropertyValue("--glass-blur"), "16px");
  assert.equal(el.classList.contains("player-theme-glass"), true);
  applyDashboardTheme(buildTheme({ sourcePalette: SOURCE }), el);
  assert.equal(el.classList.contains("player-theme-glass"), false);
  applyDashboardTheme(buildTheme({ sourcePalette: SOURCE, glass: { opacity: 0, blur: 8 } }), el);
  assert.equal(el.classList.contains("player-theme-glass"), true);
  applyDashboardTheme(null, el);
  assert.equal(el.style.getPropertyValue("--glass-alpha"), "");
  assert.equal(el.classList.contains("player-theme-glass"), false);
});
