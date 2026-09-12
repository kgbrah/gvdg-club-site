import { PRESET_THEMES } from "./dashboard-theme-presets.js";

export { PRESET_THEMES };

export const EXTRACT_MODES = [
  "normal",
  "monochromatic",
  "analogous",
  "complementary",
  "pastel",
  "material",
  "colorful",
  "muted",
  "bright",
  "forest",
  "ocean",
  "fire",
];
export const EXTRACT_MODE_ALIASES = { mono: "monochromatic" };
export const EXTRACT_MODE_GROUPS = [
  { id: "generate", label: "Generate", modes: ["normal", "monochromatic", "analogous", "pastel", "material", "colorful", "muted", "bright"] },
  { id: "more", label: "More", modes: ["complementary", "forest", "ocean", "fire"] },
];
export const EXTRACT_MODE_META = {
  normal: { label: "Normal", description: "Balanced 16-color ANSI palette from the wallpaper" },
  monochromatic: { label: "Mono", description: "Single hue, varying lightness" },
  analogous: { label: "Analogous", description: "Hues within ±30° of the dominant color" },
  complementary: { label: "Complement", description: "Base hue alternating with its opposite" },
  pastel: { label: "Pastel", description: "Soft, muted colors" },
  material: { label: "Material", description: "Material Design-inspired bg/fg" },
  colorful: { label: "Colorful", description: "High saturation, vibrant" },
  muted: { label: "Muted", description: "Desaturated, subtle" },
  bright: { label: "Bright", description: "High brightness colors" },
  forest: { label: "Forest", description: "Woodland green-black, sage accents" },
  ocean: { label: "Ocean", description: "Deep blue-black, cool accents" },
  fire: { label: "Fire", description: "Bonfire warmth, ember darks" },
};
export const THEME_MODES = ["dark", "light"];
export const ANSI_SLOT_ROLES = ["BG", "RD", "GR", "YL", "BL", "MG", "CY", "FG", "DIM", "RD+", "GR+", "YL+", "BL+", "MG+", "CY+", "FG+"];
export const ANSI_HUES = [0, 120, 60, 240, 300, 180];
export const TOKEN_KEYS = [
  "primary",
  "primary-strong",
  "secondary",
  "accent",
  "green",
  "bg-primary",
  "bg-secondary",
  "bg-tertiary",
  "border-color",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "text-muted",
  "secondary-text",
];
export const HEX = /^#[0-9a-fA-F]{6}$/;
export const WALLPAPER_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_WALLPAPER_CHARS = 280_000;
export const THEME_STORAGE_PREFIX = "gvdg_dashboard_theme:";
export const ADJUSTMENT_LIMITS = {
  vibrance: { min: -50, max: 50, step: 5, default: 0, label: "Vibrance" },
  saturation: { min: -100, max: 100, step: 5, default: 0, label: "Saturation" },
  contrast: { min: -30, max: 30, step: 5, default: 0, label: "Contrast" },
  brightness: { min: -30, max: 30, step: 5, default: 0, label: "Brightness" },
  shadows: { min: -50, max: 50, step: 5, default: 0, label: "Shadows" },
  highlights: { min: -50, max: 50, step: 5, default: 0, label: "Highlights" },
  hueShift: { min: -180, max: 180, step: 10, default: 0, label: "Hue" },
  temperature: { min: -50, max: 50, step: 5, default: 0, label: "Temperature" },
  tint: { min: -50, max: 50, step: 5, default: 0, label: "Tint" },
  blackPoint: { min: -30, max: 30, step: 5, default: 0, label: "Black point" },
  whitePoint: { min: -30, max: 30, step: 5, default: 0, label: "White point" },
  gamma: { min: 0.5, max: 2, step: 0.1, default: 1, label: "Gamma" },
};
export const ADJUSTMENT_KEYS = Object.keys(ADJUSTMENT_LIMITS);
export const DEFAULT_ADJUSTMENTS = Object.fromEntries(
  ADJUSTMENT_KEYS.map((key) => [key, ADJUSTMENT_LIMITS[key].default]),
);

export function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

export function rgb(r, g, b) {
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((n) => clampByte(n).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex) {
  if (!HEX.test(String(hex || ""))) return null;
  return rgb(
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  );
}

export function relativeLuminance({ r, g, b }) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const hi = Math.max(first, second);
  const lo = Math.min(first, second);
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastGrade(ratio) {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA large";
  return "fail";
}

export function saturation({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return clampByte(encoded * 255);
}

export function rgbToOklch({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(a, b2);
  let H = Math.atan2(b2, a) * (180 / Math.PI);
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
}

export function oklchToRgb({ l, c, h }) {
  const hue = ((h % 360) + 360) % 360 * (Math.PI / 180);
  const a = (c || 0) * Math.cos(hue);
  const b2 = (c || 0) * Math.sin(hue);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b2;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b2;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b2;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  return rgb(
    linearToSrgb(+4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3),
  );
}

function oklchHex(l, c, h) {
  return rgbToHex(oklchToRgb({ l, c, h }));
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };
  const delta = max - min;
  const sat = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return { h: hue / 6, s: sat, l: lightness };
}

function hueToRgb(p, q, t) {
  let tone = t;
  if (tone < 0) tone += 1;
  if (tone > 1) tone -= 1;
  if (tone < 1 / 6) return p + (q - p) * 6 * tone;
  if (tone < 1 / 2) return q;
  if (tone < 2 / 3) return p + (q - p) * (2 / 3 - tone) * 6;
  return p;
}

function hslToRgb({ h, s, l }) {
  if (s === 0) {
    const value = Math.round(l * 255);
    return rgb(value, value, value);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgb(
    hueToRgb(p, q, h + 1 / 3) * 255,
    hueToRgb(p, q, h) * 255,
    hueToRgb(p, q, h - 1 / 3) * 255,
  );
}

function mix(a, b, amount) {
  return rgb(
    a.r + (b.r - a.r) * amount,
    a.g + (b.g - a.g) * amount,
    a.b + (b.b - a.b) * amount,
  );
}

function shiftLightness(color, delta) {
  const lch = rgbToOklch(color);
  return oklchToRgb({ ...lch, l: Math.max(0, Math.min(1, lch.l + delta)) });
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function hueDistance(a, b) {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function pullHueToward(hue, target, strength) {
  const diff = ((target - hue + 540) % 360) - 180;
  return (hue + diff * strength + 360) % 360;
}

export function normalizeExtractMode(value) {
  const aliased = EXTRACT_MODE_ALIASES[value] || value;
  return EXTRACT_MODES.includes(aliased) ? aliased : "normal";
}

export function sanitizeAdjustments(raw) {
  const next = { ...DEFAULT_ADJUSTMENTS };
  if (!raw || typeof raw !== "object") return next;
  for (const key of ADJUSTMENT_KEYS) {
    const limit = ADJUSTMENT_LIMITS[key];
    const value = Number(raw[key]);
    if (Number.isFinite(value)) next[key] = clamp(value, limit.min, limit.max);
  }
  return next;
}

export function adjustmentsAreDefault(adjustments) {
  const safe = sanitizeAdjustments(adjustments);
  return ADJUSTMENT_KEYS.every((key) => safe[key] === DEFAULT_ADJUSTMENTS[key]);
}

function channelRange(bucket, channel) {
  let min = 255;
  let max = 0;
  for (const color of bucket) {
    if (color[channel] < min) min = color[channel];
    if (color[channel] > max) max = color[channel];
  }
  return max - min;
}

function widestChannel(bucket) {
  const ranges = {
    r: channelRange(bucket, "r"),
    g: channelRange(bucket, "g"),
    b: channelRange(bucket, "b"),
  };
  if (ranges.g >= ranges.r && ranges.g >= ranges.b) return "g";
  if (ranges.b >= ranges.r && ranges.b >= ranges.g) return "b";
  return "r";
}

function averageColor(bucket) {
  if (!bucket.length) return rgb(0, 0, 0);
  const total = bucket.reduce((sum, color) => ({
    r: sum.r + color.r,
    g: sum.g + color.g,
    b: sum.b + color.b,
  }), { r: 0, g: 0, b: 0 });
  return rgb(total.r / bucket.length, total.g / bucket.length, total.b / bucket.length);
}

export function medianCut(pixels, maxColors = 16) {
  const source = Array.isArray(pixels) ? pixels.filter((color) => color && Number.isFinite(color.r)) : [];
  if (!source.length) return [];
  const buckets = [source.slice()];
  while (buckets.length < maxColors) {
    buckets.sort((left, right) => Math.max(
      channelRange(right, "r"),
      channelRange(right, "g"),
      channelRange(right, "b"),
    ) - Math.max(
      channelRange(left, "r"),
      channelRange(left, "g"),
      channelRange(left, "b"),
    ));
    const bucket = buckets.shift();
    if (!bucket || bucket.length < 2) {
      if (bucket?.length) buckets.unshift(bucket);
      break;
    }
    const channel = widestChannel(bucket);
    bucket.sort((left, right) => left[channel] - right[channel]);
    const mid = Math.floor(bucket.length / 2);
    buckets.push(bucket.slice(0, mid), bucket.slice(mid));
  }
  return buckets.map(averageColor);
}

export function samplePixels(data, width, height, target = 3600) {
  if (!data || !width || !height) return [];
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / target)));
  const pixels = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      if ((data[index + 3] || 0) < 128) continue;
      pixels.push(rgb(data[index], data[index + 1], data[index + 2]));
    }
  }
  return pixels;
}

function ensureContrast(foreground, background, minimum = 4.5) {
  let color = foreground;
  let guard = 0;
  while (contrastRatio(color, background) < minimum && guard < 24) {
    color = shiftLightness(color, relativeLuminance(background) > 0.45 ? -0.06 : 0.06);
    guard += 1;
  }
  if (contrastRatio(color, background) < minimum) {
    return relativeLuminance(background) > 0.45 ? rgb(18, 18, 28) : rgb(246, 246, 250);
  }
  return color;
}

function dominantHue(colors) {
  let best = colors[0] || rgb(80, 120, 90);
  let chroma = -1;
  for (const color of colors) {
    const lch = rgbToOklch(color);
    if (lch.c > chroma) {
      chroma = lch.c;
      best = color;
    }
  }
  return rgbToOklch(best).h;
}

function commentColor(backgroundHex) {
  const bg = hexToRgb(backgroundHex) || rgb(16, 16, 24);
  const lch = rgbToOklch(bg);
  const target = lch.l < 0.5 ? Math.min(1, lch.l + 0.3) : Math.max(0, lch.l - 0.3);
  return oklchHex(target, Math.min(0.02, lch.c), lch.h);
}

function brightVersion(hex, lightMode) {
  const color = hexToRgb(hex) || rgb(180, 180, 180);
  const lch = rgbToOklch(color);
  return oklchHex(
    clamp(lch.l + (lightMode ? -0.08 : 0.08), 0.12, 0.97),
    lch.c + 0.02,
    lch.h,
  );
}

function finalizeAnsi(slots, lightMode) {
  const palette = slots.slice();
  palette[8] = commentColor(palette[0]);
  for (let i = 1; i <= 6; i += 1) palette[i + 8] = brightVersion(palette[i], lightMode);
  palette[15] = brightVersion(palette[7], lightMode);
  return palette;
}

function pickByHue(colors, targetHue, used) {
  let best = -1;
  let bestDist = Infinity;
  colors.forEach((color, index) => {
    if (used.has(index)) return;
    const dist = hueDistance(rgbToOklch(color).h, targetHue);
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}

function hexPalette(colors) {
  return colors.map((color) => (typeof color === "string" ? color : rgbToHex(color)));
}

function generateNormalPalette(colors, lightMode) {
  const ordered = colors.slice().sort((left, right) => relativeLuminance(left) - relativeLuminance(right));
  const dark = ordered[0] || rgb(12, 12, 20);
  const light = ordered[ordered.length - 1] || rgb(240, 240, 245);
  const used = new Set();
  const slots = new Array(16).fill("#000000");
  const bg = lightMode ? mix(light, rgb(255, 255, 255), 0.28) : mix(dark, rgb(8, 8, 16), 0.28);
  const fg = lightMode ? mix(dark, rgb(20, 20, 28), 0.35) : mix(light, rgb(255, 255, 255), 0.12);
  slots[0] = rgbToHex(bg);
  slots[7] = rgbToHex(fg);
  ANSI_HUES.forEach((hue, index) => {
    const match = pickByHue(colors, hue, used);
    if (match >= 0) {
      used.add(match);
      const lch = rgbToOklch(colors[match]);
      slots[index + 1] = oklchHex(
        clamp(lightMode ? Math.min(0.55, lch.l) : Math.max(0.48, lch.l), 0.28, 0.82),
        clamp(Math.max(lch.c, 0.06), 0.05, 0.18),
        lch.h,
      );
    } else {
      slots[index + 1] = oklchHex(lightMode ? 0.48 : 0.64, 0.12, hue);
    }
  });
  return finalizeAnsi(slots, lightMode);
}

function generateMonochromaticPalette(colors, lightMode) {
  const hue = dominantHue(colors);
  const slots = new Array(16).fill("#000000");
  slots[0] = oklchHex(lightMode ? 0.94 : 0.14, 0.022, hue);
  slots[7] = oklchHex(lightMode ? 0.22 : 0.88, 0.03, hue);
  const chromas = [0.09, 0.11, 0.13, 0.1, 0.12, 0.14];
  const stagger = [-0.08, -0.02, 0.06, -0.05, 0.02, 0.08];
  const baseL = lightMode ? 0.48 : 0.64;
  ANSI_HUES.forEach((canonical, index) => {
    const folded = pullHueToward(canonical, hue, 0.82);
    slots[index + 1] = oklchHex(clamp(baseL + stagger[index], 0.3, 0.82), chromas[index], folded);
  });
  return finalizeAnsi(slots, lightMode);
}

function generateAnalogousPalette(colors, lightMode) {
  const hue = dominantHue(colors);
  const ordered = colors.slice().sort((left, right) => relativeLuminance(left) - relativeLuminance(right));
  const slots = new Array(16).fill("#000000");
  slots[0] = oklchHex(lightMode ? 0.94 : Math.min(0.16, rgbToOklch(ordered[0] || rgb(10, 10, 16)).l), 0.03, hue);
  slots[7] = oklchHex(lightMode ? 0.26 : 0.9, 0.03, hue);
  const offsets = [-30, -18, -6, 6, 18, 30];
  const chromas = [0.1, 0.13, 0.09, 0.14, 0.1, 0.12];
  const stagger = [-0.06, 0.04, -0.04, 0.06, -0.05, 0.05];
  const baseL = lightMode ? 0.5 : 0.62;
  offsets.forEach((offset, index) => {
    slots[index + 1] = oklchHex(
      clamp(baseL + stagger[index], 0.3, 0.85),
      chromas[index],
      (hue + offset + 360) % 360,
    );
  });
  return finalizeAnsi(slots, lightMode);
}

function generateComplementaryPalette(colors, lightMode) {
  const hue = dominantHue(colors);
  const complement = (hue + 180) % 360;
  const slots = new Array(16).fill("#000000");
  slots[0] = oklchHex(lightMode ? 0.96 : 0.13, 0.022, hue);
  slots[7] = oklchHex(lightMode ? 0.22 : 0.88, 0.025, hue);
  const hues = [hue - 8, complement - 8, hue, complement, hue + 8, complement + 8];
  const chromas = [0.14, 0.14, 0.11, 0.11, 0.16, 0.16];
  const stagger = [-0.06, -0.04, 0.04, 0.02, 0.08, 0.06];
  const baseL = lightMode ? 0.48 : 0.65;
  hues.forEach((slotHue, index) => {
    slots[index + 1] = oklchHex(clamp(baseL + stagger[index], 0.3, 0.85), chromas[index], (slotHue + 360) % 360);
  });
  return finalizeAnsi(slots, lightMode);
}

function generateShapedPalette(colors, lightMode, spec) {
  const hue = spec.hue ?? dominantHue(colors);
  const slots = new Array(16).fill("#000000");
  const bg = lightMode ? spec.bgLight : spec.bgDark;
  const fg = lightMode ? spec.fgLight : spec.fgDark;
  slots[0] = oklchHex(bg.l, bg.c, bg.h ?? hue);
  slots[7] = oklchHex(fg.l, fg.c, fg.h ?? hue);
  const ansiL = lightMode ? spec.ansiLight : spec.ansiDark;
  ANSI_HUES.forEach((canonical, index) => {
    const source = colors[index] || colors[0] || rgb(80, 80, 90);
    const lch = rgbToOklch(source);
    const shapedHue = spec.hueAnchor != null
      ? pullHueToward(lch.h || canonical, spec.hueAnchor, spec.hueStrength || 0)
      : lch.h || canonical;
    const chroma = clamp(
      spec.cScale ? lch.c * spec.cScale : Math.max(lch.c, spec.cMin || 0),
      spec.cMin || 0.03,
      spec.cMax || 0.18,
    );
    slots[index + 1] = oklchHex(
      clamp(ansiL + (spec.stagger?.[index] || 0), 0.2, 0.9),
      chroma,
      shapedHue,
    );
  });
  return finalizeAnsi(slots, lightMode);
}

function generateMaterialPalette(colors, lightMode) {
  const slots = new Array(16).fill("#000000");
  slots[0] = lightMode ? "#fafafa" : "#121212";
  slots[7] = lightMode ? "#212121" : "#ffffff";
  const used = new Set();
  ANSI_HUES.forEach((hue, index) => {
    const match = pickByHue(colors, hue, used);
    const source = match >= 0 ? colors[match] : oklchToRgb({ l: 0.55, c: 0.12, h: hue });
    if (match >= 0) used.add(match);
    const hsl = rgbToHsl(source);
    const sat = Math.max(hsl.s, 0.35);
    const light = lightMode ? clamp(hsl.l, 0.35, 0.6) : clamp(hsl.l, 0.45, 0.7);
    slots[index + 1] = rgbToHex(hslToRgb({ h: hsl.h, s: sat, l: light }));
  });
  slots[8] = lightMode ? "#757575" : "#9e9e9e";
  for (let i = 1; i <= 6; i += 1) {
    const hsl = rgbToHsl(hexToRgb(slots[i]));
    slots[i + 8] = rgbToHex(hslToRgb({
      h: hsl.h,
      s: Math.min(1, hsl.s + 0.08),
      l: lightMode ? Math.max(0.3, hsl.l - 0.08) : Math.min(0.75, hsl.l + 0.08),
    }));
  }
  slots[15] = lightMode ? "#000000" : "#ffffff";
  return slots;
}

const MODE_SHAPES = {
  pastel: {
    bgDark: { l: 0.2, c: 0.022 },
    bgLight: { l: 0.96, c: 0.012 },
    fgDark: { l: 0.85, c: 0.04 },
    fgLight: { l: 0.32, c: 0.05 },
    ansiDark: 0.78,
    ansiLight: 0.55,
    cMin: 0.045,
    cMax: 0.075,
    stagger: [-0.04, 0.02, 0.05, -0.03, -0.01, 0.03],
  },
  colorful: {
    bgDark: { l: 0.1, c: 0.022 },
    bgLight: { l: 0.97, c: 0.012 },
    fgDark: { l: 0.92, c: 0.03 },
    fgLight: { l: 0.18, c: 0.04 },
    ansiDark: 0.7,
    ansiLight: 0.5,
    cMin: 0.14,
    cMax: 0.2,
    stagger: [-0.04, 0.02, 0.05, -0.03, -0.01, 0.03],
  },
  muted: {
    bgDark: { l: 0.16, c: 0.018 },
    bgLight: { l: 0.94, c: 0.01 },
    fgDark: { l: 0.84, c: 0.035 },
    fgLight: { l: 0.28, c: 0.045 },
    ansiDark: 0.62,
    ansiLight: 0.48,
    cMin: 0.035,
    cMax: 0.065,
    cScale: 0.5,
    stagger: [-0.1, -0.04, 0.04, 0.1, -0.07, 0.07],
  },
  bright: {
    bgDark: { l: 0.1, c: 0.02 },
    bgLight: { l: 0.98, c: 0.01 },
    fgDark: { l: 0.92, c: 0.025 },
    fgLight: { l: 0.15, c: 0.04 },
    ansiDark: 0.78,
    ansiLight: 0.42,
    cMin: 0.1,
    cMax: 0.18,
    stagger: [-0.04, 0.01, 0.06, -0.03, -0.02, 0.03],
  },
  forest: {
    bgDark: { l: 0.13, c: 0.04, h: 145 },
    bgLight: { l: 0.95, c: 0.025, h: 130 },
    fgDark: { l: 0.88, c: 0.035, h: 125 },
    fgLight: { l: 0.24, c: 0.05, h: 140 },
    ansiDark: 0.66,
    ansiLight: 0.46,
    hueAnchor: 145,
    hueStrength: 0.25,
    cMin: 0.06,
    cMax: 0.1,
    stagger: [-0.05, 0.01, 0.07, -0.04, -0.02, 0.03],
  },
  ocean: {
    bgDark: { l: 0.1, c: 0.05, h: 240 },
    bgLight: { l: 0.96, c: 0.03, h: 215 },
    fgDark: { l: 0.9, c: 0.035, h: 205 },
    fgLight: { l: 0.2, c: 0.055, h: 230 },
    ansiDark: 0.6,
    ansiLight: 0.44,
    hueAnchor: 220,
    hueStrength: 0.28,
    cMin: 0.09,
    cMax: 0.14,
    stagger: [-0.05, 0.02, 0.06, -0.03, -0.01, 0.03],
  },
  fire: {
    bgDark: { l: 0.09, c: 0.045, h: 28 },
    bgLight: { l: 0.95, c: 0.03, h: 45 },
    fgDark: { l: 0.9, c: 0.04, h: 55 },
    fgLight: { l: 0.22, c: 0.06, h: 20 },
    ansiDark: 0.62,
    ansiLight: 0.46,
    hueAnchor: 30,
    hueStrength: 0.28,
    cMin: 0.07,
    cMax: 0.12,
    stagger: [-0.05, 0.01, 0.07, -0.04, -0.02, 0.03],
  },
};

export function applyExtractMode(color, extractMode) {
  const lch = rgbToOklch(color);
  if (extractMode === "muted") return oklchToRgb({ ...lch, c: lch.c * 0.55 });
  if (extractMode === "colorful") return oklchToRgb({ ...lch, c: Math.min(0.22, lch.c * 1.35) });
  if (extractMode === "pastel") return oklchToRgb({ ...lch, c: lch.c * 0.55, l: Math.min(0.86, lch.l + 0.12) });
  if (extractMode === "bright") return oklchToRgb({ ...lch, l: Math.min(0.88, lch.l + 0.1), c: Math.max(lch.c, 0.1) });
  return color;
}

export function paletteFromPixels(pixels, extractMode = "normal", mode = "dark") {
  const cut = medianCut(pixels, 16);
  if (!cut.length) return [];
  const lightMode = mode === "light";
  const safeExtract = normalizeExtractMode(extractMode);
  if (safeExtract === "monochromatic") return generateMonochromaticPalette(cut, lightMode);
  if (safeExtract === "analogous") return generateAnalogousPalette(cut, lightMode);
  if (safeExtract === "complementary") return generateComplementaryPalette(cut, lightMode);
  if (safeExtract === "material") return generateMaterialPalette(cut, lightMode);
  if (MODE_SHAPES[safeExtract]) return generateShapedPalette(cut, lightMode, MODE_SHAPES[safeExtract]);
  return generateNormalPalette(cut, lightMode);
}

export function applyAdjustments(palette, adjustments) {
  const adj = sanitizeAdjustments(adjustments);
  return (Array.isArray(palette) ? palette : []).map((hex) => {
    const color = hexToRgb(hex);
    if (!color) return hex;
    const lch = rgbToOklch(color);
    lch.h = (lch.h + adj.hueShift + 360) % 360;
    lch.c *= 1 + adj.saturation / 100;
    const vibrance = adj.vibrance / 50;
    lch.c *= 1 + vibrance * (1 - Math.min(1, lch.c / 0.18));
    if (adj.temperature) lch.h = pullHueToward(lch.h, adj.temperature > 0 ? 50 : 240, Math.abs(adj.temperature) / 80);
    if (adj.tint) lch.h = pullHueToward(lch.h, adj.tint > 0 ? 140 : 320, Math.abs(adj.tint) / 80);
    lch.l += adj.brightness / 200;
    lch.l = 0.5 + (lch.l - 0.5) * (1 + adj.contrast / 60);
    if (lch.l < 0.45) lch.l += adj.shadows / 250;
    if (lch.l > 0.55) lch.l += adj.highlights / 250;
    if (lch.l < 0.35) lch.l += adj.blackPoint / 250;
    if (lch.l > 0.65) lch.l += adj.whitePoint / 250;
    const gamma = adj.gamma || 1;
    lch.l = clamp(lch.l, 0, 1) ** (1 / gamma);
    lch.c = Math.max(0, lch.c);
    return rgbToHex(oklchToRgb(lch));
  });
}

function sanitizeHexList(values, max = 16) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").toLowerCase())
    .filter((value) => HEX.test(value))
    .slice(0, max);
}

export function tokensFromPalette(palette, mode = "dark") {
  const colors = (Array.isArray(palette) ? palette : [])
    .map((color) => (typeof color === "string" ? hexToRgb(color) : color))
    .filter(Boolean);
  if (!colors.length) return null;
  if (colors.length >= 8) {
    const bg = colors[0];
    const fg = colors[7] || colors[colors.length - 1];
    const dim = colors[8] || mix(bg, fg, 0.35);
    const red = colors[1] || fg;
    const green = colors[2] || red;
    const yellow = colors[3] || red;
    const blue = colors[4] || red;
    const cyan = colors[6] || blue;
    return {
      primary: rgbToHex(ensureContrast(red, bg, 3)),
      "primary-strong": rgbToHex(shiftLightness(red, mode === "light" ? -0.1 : -0.06)),
      secondary: rgbToHex(blue),
      accent: rgbToHex(yellow),
      green: rgbToHex(green),
      "bg-primary": rgbToHex(bg),
      "bg-secondary": rgbToHex(mix(bg, fg, mode === "light" ? 0.06 : 0.1)),
      "bg-tertiary": rgbToHex(dim),
      "border-color": rgbToHex(mix(dim, fg, 0.22)),
      "text-primary": rgbToHex(ensureContrast(fg, bg)),
      "text-secondary": rgbToHex(mix(fg, dim, 0.25)),
      "text-tertiary": rgbToHex(mix(fg, dim, 0.45)),
      "text-muted": rgbToHex(ensureContrast(dim, bg, 3.2)),
      "secondary-text": rgbToHex(ensureContrast(cyan, bg, 3.5)),
    };
  }
  const ordered = colors.slice().sort((left, right) => relativeLuminance(left) - relativeLuminance(right));
  const dark = ordered[0];
  const light = ordered[ordered.length - 1];
  const background = mode === "light" ? mix(light, rgb(255, 255, 255), 0.28) : mix(dark, rgb(8, 8, 16), 0.35);
  const text = ensureContrast(mode === "light" ? dark : light, background);
  return tokensFromPalette(hexPalette([
    background,
    ordered[1] || dark,
    ordered[2] || dark,
    ordered[3] || light,
    ordered[4] || dark,
    ordered[5] || dark,
    ordered[6] || dark,
    text,
  ]), mode);
}

export function themeContrast(theme) {
  const tokens = theme?.tokens;
  if (!tokens) return null;
  const fg = hexToRgb(tokens["text-primary"]);
  const bg = hexToRgb(tokens["bg-primary"]);
  if (!fg || !bg) return null;
  const ratio = contrastRatio(fg, bg);
  return { ratio, grade: contrastGrade(ratio) };
}

function swapAnchors(palette) {
  const next = palette.slice();
  if (next.length < 8) return next;
  const bg = hexToRgb(next[0]);
  const fg = hexToRgb(next[15] || next[7]);
  if (bg && fg && relativeLuminance(bg) < relativeLuminance(fg)) {
    const end = next[15] || next[7];
    next[15] = next[0];
    next[0] = end;
    if (next[7] && next[8]) {
      const dim = next[8];
      next[8] = next[7];
      next[7] = dim;
    }
  }
  return next;
}

export function buildTheme({
  pixels,
  mode = "dark",
  extractMode = "normal",
  wallpaper = null,
  adjustments,
  sourcePalette,
  preset = null,
  palette: editedPalette,
} = {}) {
  const safeMode = THEME_MODES.includes(mode) ? mode : "dark";
  const safeExtract = normalizeExtractMode(extractMode);
  const safeAdjustments = sanitizeAdjustments(adjustments);
  const safePreset = preset && PRESET_THEMES[preset] ? preset : null;
  let source = sanitizeHexList(sourcePalette);
  if (pixels?.length) source = paletteFromPixels(pixels, safeExtract, safeMode);
  else if (safePreset) {
    source = PRESET_THEMES[safePreset].map((hex) => hex.toLowerCase());
    if (safeMode === "light") source = swapAnchors(source);
  }
  if (source.length && source.length < 16) {
    const filled = source.slice();
    while (filled.length < 16) filled.push(filled[filled.length - 1]);
    source = filled;
  }
  if (!source.length) return null;
  const palette = editedPalette?.length === 16 && editedPalette.every((hex) => HEX.test(hex))
    ? editedPalette.map((hex) => hex.toLowerCase())
    : applyAdjustments(source, safeAdjustments);
  const tokens = tokensFromPalette(palette, safeMode);
  if (!tokens) return null;
  return {
    mode: safeMode,
    extractMode: safeExtract,
    preset: safePreset,
    adjustments: safeAdjustments,
    sourcePalette: source,
    palette,
    tokens,
    wallpaper: typeof wallpaper === "string" && WALLPAPER_RE.test(wallpaper) ? wallpaper : null,
  };
}

export function sanitizeTheme(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mode = THEME_MODES.includes(raw.mode) ? raw.mode : "dark";
  const extractMode = normalizeExtractMode(raw.extractMode);
  const preset = raw.preset && PRESET_THEMES[raw.preset] ? raw.preset : null;
  const adjustments = sanitizeAdjustments(raw.adjustments);
  const palette = sanitizeHexList(raw.palette);
  const sourcePalette = sanitizeHexList(raw.sourcePalette);
  const tokens = {};
  if (raw.tokens && typeof raw.tokens === "object") {
    for (const key of TOKEN_KEYS) {
      const value = String(raw.tokens[key] || "").toLowerCase();
      if (HEX.test(value)) tokens[key] = value;
    }
  }
  if (TOKEN_KEYS.some((key) => !tokens[key])) {
    const rebuilt = tokensFromPalette(palette.length ? palette : Object.values(tokens), mode);
    if (!rebuilt) return null;
    for (const key of TOKEN_KEYS) {
      if (!tokens[key]) tokens[key] = rebuilt[key];
    }
  }
  const wallpaper = typeof raw.wallpaper === "string" && WALLPAPER_RE.test(raw.wallpaper) && raw.wallpaper.length <= MAX_WALLPAPER_CHARS
    ? raw.wallpaper
    : null;
  if (!palette.length && !wallpaper && !preset) return { mode, extractMode, preset, adjustments, sourcePalette, palette, tokens, wallpaper };
  return {
    mode,
    extractMode,
    preset,
    adjustments,
    sourcePalette: sourcePalette.length ? sourcePalette : palette.slice(),
    palette,
    tokens,
    wallpaper,
  };
}

export function themeStorageKey(memberId) {
  return `${THEME_STORAGE_PREFIX}${memberId || "anon"}`;
}

export function readStoredTheme(storage, memberId) {
  try {
    const raw = storage?.getItem?.(themeStorageKey(memberId));
    return raw ? sanitizeTheme(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeStoredTheme(storage, memberId, theme) {
  const safe = sanitizeTheme(theme);
  if (!safe) {
    storage?.removeItem?.(themeStorageKey(memberId));
    return null;
  }
  storage?.setItem?.(themeStorageKey(memberId), JSON.stringify(safe));
  return safe;
}

export function clearStoredTheme(storage, memberId) {
  storage?.removeItem?.(themeStorageKey(memberId));
}

export function applyDashboardTheme(theme, root) {
  if (!root || !root.style) return;
  if (!theme) {
    for (const key of TOKEN_KEYS) root.style.removeProperty(`--${key}`);
    root.style.removeProperty("--player-theme-image");
    root.classList.remove("player-theme-active");
    return;
  }
  const safe = sanitizeTheme(theme);
  if (!safe) return;
  for (const key of TOKEN_KEYS) root.style.setProperty(`--${key}`, safe.tokens[key]);
  if (safe.wallpaper) {
    const scrim = safe.mode === "dark"
      ? "linear-gradient(rgba(8, 10, 18, 0.62), rgba(8, 10, 18, 0.8))"
      : "linear-gradient(rgba(255, 255, 255, 0.58), rgba(248, 248, 252, 0.78))";
    root.style.setProperty("--player-theme-image", `${scrim}, url("${safe.wallpaper}")`);
    root.classList.add("player-theme-active");
  } else {
    root.style.removeProperty("--player-theme-image");
    root.classList.remove("player-theme-active");
  }
}
