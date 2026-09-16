import React from "react";

import { request, TOKEN_KEY, storageGet } from "./api.js";
import { useMemberContext } from "./member-context.js";
import { resizeImageFile } from "./tee-signs-utils.js";
import {
  ADJUSTMENT_KEYS,
  ADJUSTMENT_LIMITS,
  ANSI_SLOT_ROLES,
  DEFAULT_ADJUSTMENTS,
  EXTRACT_MODE_GROUPS,
  EXTRACT_MODE_META,
  MAX_WALLPAPER_CHARS,
  PRESET_THEMES,
  applyDashboardTheme,
  buildTheme,
  clearStoredTheme,
  readStoredTheme,
  samplePixels,
  sanitizeAdjustments,
  sanitizeTheme,
  themeContrast,
  tokensFromPalette,
  writeStoredTheme,
} from "../shared/dashboard-theme-model.js";
import { THEME_EVENT, notifyPlayerThemeChanged } from "../shared/player-theme-session.js";
import { themeRoot } from "../shared/player-theme-chrome.js";

const h = React.createElement;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image"));
    image.src = src;
  });
}

export async function pixelsFromDataUrl(dataUrl) {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, 300 / Math.max(image.width || 1, image.height || 1));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  return samplePixels(data, width, height);
}

function Slider({ name, value, disabled, onChange }) {
  const limit = ADJUSTMENT_LIMITS[name];
  return h("label", { className: "dash-theme-slider", key: name }, [
    h("span", { className: "dash-theme-slider-label", key: "label" }, [
      limit.label,
      h("em", { key: "val" }, String(value)),
    ]),
    h("input", {
      type: "range",
      min: limit.min,
      max: limit.max,
      step: limit.step,
      value,
      disabled,
      "aria-label": limit.label,
      onChange: (event) => onChange(name, Number(event.target.value)),
      onDoubleClick: () => onChange(name, limit.default),
      key: "input",
    }),
  ]);
}

export function DashboardThemeBuilder() {
  const context = useMemberContext();
  const token = storageGet(TOKEN_KEY);
  const memberId = context.sub || context.pdgaNo || "me";
  const [theme, setTheme] = React.useState(null);
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [extractMode, setExtractMode] = React.useState("normal");
  const [mode, setMode] = React.useState("dark");
  const [adjustments, setAdjustments] = React.useState(DEFAULT_ADJUSTMENTS);
  const [dragging, setDragging] = React.useState(false);
  const pixelsRef = React.useRef(null);
  const fileRef = React.useRef(null);
  const editedRef = React.useRef(false);
  const paletteEditedRef = React.useRef(false);
  const persistTimer = React.useRef(0);
  const persistGen = React.useRef(0);
  const persistChain = React.useRef(Promise.resolve());
  const pendingTheme = React.useRef(null);

  const paint = React.useCallback((next) => {
    const safe = sanitizeTheme(next);
    setTheme(safe);
    if (safe) {
      setExtractMode(safe.extractMode);
      setMode(safe.mode);
      setAdjustments(sanitizeAdjustments(safe.adjustments));
    } else {
      setExtractMode("normal");
      setMode("dark");
      setAdjustments(DEFAULT_ADJUSTMENTS);
    }
    applyDashboardTheme(safe, themeRoot());
    notifyPlayerThemeChanged(safe);
    return safe;
  }, []);

  React.useEffect(() => () => {
    applyDashboardTheme(null, themeRoot());
    notifyPlayerThemeChanged(null);
  }, []);

  React.useEffect(() => {
    function onThemeEvent(event) {
      if (!Object.prototype.hasOwnProperty.call(event.detail || {}, "theme")) return;
      const next = sanitizeTheme(event.detail.theme);
      applyDashboardTheme(next, themeRoot());
      if (!next) {
        setTheme(null);
        setExtractMode("normal");
        setMode("dark");
        setAdjustments(DEFAULT_ADJUSTMENTS);
        return;
      }
      setTheme(next);
      setExtractMode(next.extractMode);
      setMode(next.mode);
      setAdjustments(sanitizeAdjustments(next.adjustments));
    }
    window.addEventListener(THEME_EVENT, onThemeEvent);
    return () => window.removeEventListener(THEME_EVENT, onThemeEvent);
  }, []);

  React.useEffect(() => {
    editedRef.current = false;
    pixelsRef.current = null;
    paletteEditedRef.current = false;
    if (!token) {
      paint(null);
      return undefined;
    }
    const local = readStoredTheme(window.localStorage, memberId);
    paint(local);
    const controller = new AbortController();
    request("/me/dashboard-theme", { token, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        if (editedRef.current) return;
        const remote = sanitizeTheme(data?.theme);
        if (remote) {
          writeStoredTheme(window.localStorage, memberId, remote);
          paint(remote);
          return;
        }
        if (data && Object.prototype.hasOwnProperty.call(data, "theme") && !data.theme && !local) {
          paint(null);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [token, memberId, paint]);

  async function persist(next, immediate = true) {
    editedRef.current = true;
    writeStoredTheme(window.localStorage, memberId, next);
    persistGen.current += 1;
    const gen = persistGen.current;
    pendingTheme.current = next;
    if (!token) return true;

    const sendLatest = async () => {
      if (gen !== persistGen.current) return true;
      const payload = pendingTheme.current;
      try {
        const response = await request("/me/dashboard-theme", {
          token,
          method: payload ? "PUT" : "DELETE",
          body: payload ? { theme: payload } : undefined,
        });
        if (gen !== persistGen.current) return true;
        return Boolean(response && response.ok);
      } catch {
        return gen !== persistGen.current;
      }
    };

    const enqueue = () => {
      persistChain.current = persistChain.current.catch(() => {}).then(sendLatest);
      return persistChain.current;
    };

    window.clearTimeout(persistTimer.current);
    if (immediate) return enqueue();
    persistTimer.current = window.setTimeout(() => {
      enqueue().then((ok) => {
        if (!ok) setStatus("Saved on this device. Cloud save failed — try again.");
      });
    }, 400);
    return true;
  }

  async function wallpaperPixels() {
    if (pixelsRef.current?.length) return pixelsRef.current;
    if (!theme?.wallpaper) return null;
    const pixels = await pixelsFromDataUrl(theme.wallpaper);
    pixelsRef.current = pixels;
    return pixels;
  }

  async function compose(options = {}) {
    const nextMode = options.nextMode ?? mode;
    const nextExtract = options.nextExtract ?? extractMode;
    const nextAdjustments = options.nextAdjustments ?? adjustments;
    const wallpaper = options.wallpaper ?? theme?.wallpaper;
    const preset = options.preset === undefined ? theme?.preset || null : options.preset;
    const sourcePalette = options.sourcePalette === undefined ? theme?.sourcePalette : options.sourcePalette;
    const editedPalette = options.editedPalette === undefined ? null : options.editedPalette;
    const pixels = Object.prototype.hasOwnProperty.call(options, "pixels")
      ? options.pixels
      : null;
    const next = buildTheme({
      pixels: pixels || undefined,
      mode: nextMode,
      extractMode: nextExtract,
      wallpaper,
      adjustments: nextAdjustments,
      sourcePalette: pixels ? undefined : sourcePalette,
      preset: pixels ? null : preset,
      palette: editedPalette,
    });
    if (!next) return null;
    paint(next);
    await persist(next, !Object.prototype.hasOwnProperty.call(options, "nextAdjustments"));
    return next;
  }

  async function ingestFile(file) {
    if (!file) return;
    setBusy(true);
    setStatus("Reading wallpaper...");
    try {
      const wallpaper = await resizeImageFile(file, 960);
      if (!wallpaper || wallpaper.length > MAX_WALLPAPER_CHARS) {
        setStatus("That image is too large. Try a smaller JPEG or PNG.");
        return;
      }
      const pixels = await pixelsFromDataUrl(wallpaper);
      pixelsRef.current = pixels;
      paletteEditedRef.current = false;
      const next = await compose({ wallpaper, pixels, preset: null, editedPalette: null });
      if (!next) {
        setStatus("Could not read colors from that image.");
        return;
      }
      setStatus("Palette extracted. Fine-tune, then Apply Theme to keep it.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    await ingestFile(file);
  }

  async function extract() {
    if (!theme?.wallpaper && !pixelsRef.current) {
      fileRef.current?.click();
      return;
    }
    setBusy(true);
    try {
      const pixels = await wallpaperPixels();
      paletteEditedRef.current = false;
      const next = await compose({ pixels, editedPalette: null, preset: null });
      setStatus(next ? "Palette extracted." : "Could not extract a palette.");
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(nextMode) {
    setMode(nextMode);
    if (!theme) return;
    setBusy(true);
    try {
      const pixels = paletteEditedRef.current ? null : await wallpaperPixels();
      await compose({ nextMode, editedPalette: null, ...(pixels ? { pixels } : {}) });
    } finally {
      setBusy(false);
    }
  }

  async function changeExtract(nextExtract) {
    const pixels = pixelsRef.current || (theme?.wallpaper ? await wallpaperPixels() : null);
    if (!pixels?.length) {
      setStatus("Drop a wallpaper first to use extraction modes.");
      return;
    }
    setExtractMode(nextExtract);
    setBusy(true);
    try {
      paletteEditedRef.current = false;
      await compose({ nextExtract, pixels, editedPalette: null, preset: null });
      setStatus("Extraction mode updated.");
    } finally {
      setBusy(false);
    }
  }

  async function changeAdjustment(name, value) {
    const nextAdjustments = { ...adjustments, [name]: value };
    setAdjustments(nextAdjustments);
    if (!theme) return;
    await compose({ nextAdjustments, editedPalette: null });
  }

  async function resetAdjustments() {
    setAdjustments(DEFAULT_ADJUSTMENTS);
    if (!theme) return;
    await compose({ nextAdjustments: DEFAULT_ADJUSTMENTS, editedPalette: null });
  }

  async function applyPreset(name) {
    setBusy(true);
    try {
      pixelsRef.current = null;
      paletteEditedRef.current = false;
      const next = await compose({
        preset: name,
        pixels: null,
        sourcePalette: undefined,
        editedPalette: null,
      });
      setStatus(next ? `${name} preset loaded. Apply Theme to save.` : "Could not load that preset.");
    } finally {
      setBusy(false);
    }
  }

  async function recolor(index, hex) {
    if (!theme?.palette) return;
    const palette = theme.palette.slice();
    palette[index] = hex;
    setAdjustments(DEFAULT_ADJUSTMENTS);
    paletteEditedRef.current = true;
    const next = {
      ...theme,
      palette,
      sourcePalette: palette,
      adjustments: DEFAULT_ADJUSTMENTS,
      tokens: tokensFromPalette(palette, mode) || theme.tokens,
      preset: null,
    };
    paint(next);
    await persist(next);
  }

  async function applyTheme() {
    if (!theme) {
      await extract();
      return;
    }
    const ok = await persist(theme);
    setStatus(ok ? "Theme applied to your dashboard." : "Saved on this device. Cloud save failed — try again.");
  }

  async function reset() {
    pixelsRef.current = null;
    paletteEditedRef.current = false;
    paint(null);
    setExtractMode("normal");
    setMode("dark");
    setAdjustments(DEFAULT_ADJUSTMENTS);
    clearStoredTheme(window.localStorage, memberId);
    const ok = await persist(null);
    setStatus(ok ? "Club default restored." : "Cleared on this device. Cloud save failed — try again.");
  }

  if (!token) return null;

  const contrast = themeContrast(theme);
  const presetNames = Object.keys(PRESET_THEMES);
  const canExtract = Boolean(theme?.wallpaper || pixelsRef.current?.length);

  return h("details", {
    className: "dash-theme dash-collapse",
    "data-react-dashboard-theme": theme ? "custom" : "default",
    open: true,
  }, [
    h("summary", { className: "dash-subtitle dash-collapse-summary", key: "summary" }, "Dashboard theme"),
    h("p", { className: "dash-note", key: "copy" }, "Drop a wallpaper, extract a color palette, fine-tune, then apply it to your dashboard."),
    h("div", { className: "dash-theme-studio", key: "studio" }, [
      h("header", { className: "dash-theme-header", key: "header" }, [
        h("div", { className: "dash-theme-toggle", key: "look", role: "group", "aria-label": "Look" }, [
          h("button", {
            type: "button",
            className: mode === "dark" ? "is-active" : "",
            disabled: busy,
            onClick: () => changeMode("dark"),
            key: "dark",
          }, "Dark"),
          h("button", {
            type: "button",
            className: mode === "light" ? "is-active" : "",
            disabled: busy,
            onClick: () => changeMode("light"),
            key: "light",
          }, "Light"),
        ]),
      ]),
      h("div", { className: "dash-theme-body", key: "body" }, [
        h("div", { className: "dash-theme-main", key: "main" }, [
          h("label", {
            className: `dash-theme-drop${dragging ? " is-dragging" : ""}${theme?.wallpaper ? " has-wallpaper" : ""}`,
            htmlFor: "dashboardThemeFile",
            key: "drop",
            onDragEnter: (event) => { event.preventDefault(); setDragging(true); },
            onDragOver: (event) => event.preventDefault(),
            onDragLeave: () => setDragging(false),
            onDrop: (event) => {
              event.preventDefault();
              setDragging(false);
              ingestFile(event.dataTransfer?.files?.[0]);
            },
          }, [
            theme?.wallpaper
              ? h("img", { className: "dash-theme-wallpaper", src: theme.wallpaper, alt: "Dashboard wallpaper preview", key: "img" })
              : h("span", { className: "dash-theme-drop-copy", key: "empty" }, "Drop a wallpaper or choose an image"),
            h("input", {
              id: "dashboardThemeFile",
              className: "dash-theme-file",
              type: "file",
              accept: "image/jpeg,image/png,image/webp",
              disabled: busy,
              ref: fileRef,
              onChange: onFile,
              key: "file",
            }),
          ]),
          theme?.palette?.length
            ? h("div", { className: "dash-theme-palette", key: "palette", "aria-label": "Color palette" },
              theme.palette.map((hex, index) => h("label", {
                className: "dash-theme-swatch",
                key: `${hex}-${index}`,
                title: `${ANSI_SLOT_ROLES[index] || index} ${hex}`,
                style: { background: hex },
              }, [
                h("span", { className: "dash-theme-swatch-role", key: "role" }, ANSI_SLOT_ROLES[index] || String(index)),
                h("input", {
                  type: "color",
                  value: hex,
                  "aria-label": `${ANSI_SLOT_ROLES[index] || "Color"} ${index}`,
                  onChange: (event) => recolor(index, event.target.value),
                  key: "color",
                }),
              ])))
            : h("p", { className: "dash-theme-empty", key: "empty-palette" }, "Extract to fill the color grid."),
        ]),
        h("aside", { className: "dash-theme-sidebar", key: "sidebar" }, [
          EXTRACT_MODE_GROUPS.map((group) => h("div", { className: "dash-theme-mode-group", key: group.id }, [
            h("span", { className: "dash-theme-field", key: "label" }, group.label),
            h("div", { className: "dash-theme-pills", key: "pills" }, group.modes.map((name) => h("button", {
              type: "button",
              className: extractMode === name ? "is-active" : "",
              title: canExtract ? EXTRACT_MODE_META[name]?.description : "Drop a wallpaper first to use extraction modes.",
              disabled: busy || !canExtract,
              onClick: () => changeExtract(name),
              key: name,
            }, EXTRACT_MODE_META[name]?.label || name))),
          ])),
          h("div", { className: "dash-theme-adjust", key: "tune" }, [
            h("span", { className: "dash-theme-field", key: "label" }, "Adjust"),
            h("div", { className: "dash-theme-sliders", key: "sliders" }, ADJUSTMENT_KEYS.map((name) => h(Slider, {
              name,
              value: adjustments[name],
              disabled: busy || !theme,
              onChange: changeAdjustment,
              key: name,
            }))),
            h("button", {
              type: "button",
              className: "board-link",
              disabled: busy || !theme,
              onClick: resetAdjustments,
              key: "reset-adj",
            }, "Reset adjustments"),
          ]),
          contrast
            ? h("p", { className: "dash-theme-contrast", key: "contrast" }, `Text contrast ${contrast.ratio.toFixed(1)}:1 ${contrast.grade}`)
            : null,
          h("div", { className: "dash-theme-presets", key: "presets" }, [
            h("span", { className: "dash-theme-field", key: "label" }, "Presets"),
            h("div", { className: "dash-theme-preset-grid", key: "grid" }, presetNames.map((name) => h("button", {
              type: "button",
              className: `dash-theme-preset${theme?.preset === name ? " is-active" : ""}`,
              disabled: busy,
              onClick: () => applyPreset(name),
              key: name,
            }, [
              h("span", { className: "dash-theme-preset-name", key: "name" }, name),
              h("span", { className: "dash-theme-preset-bar", key: "bar" }, PRESET_THEMES[name].slice(0, 8).map((hex, index) => h("i", {
                key: `${name}-${index}`,
                style: { background: hex },
              }))),
            ]))),
          ]),
        ]),
      ]),
      h("footer", { className: "dash-theme-actionbar", key: "bar" }, [
        h("div", { className: "dash-theme-actions", key: "actions" }, [
          h("button", {
            type: "button",
            className: "board-link",
            disabled: busy,
            onClick: extract,
            "data-theme-extract": "1",
            key: "extract",
          }, busy ? "Working..." : "Extract"),
          h("button", {
            type: "button",
            className: "board-link",
            disabled: busy || !theme,
            onClick: reset,
            key: "reset",
          }, "Reset"),
        ]),
        h("button", {
          type: "button",
          className: "passkey-btn dash-theme-apply",
          disabled: busy,
          onClick: applyTheme,
          "data-theme-apply": "1",
          key: "apply",
        }, "Apply Theme"),
      ]),
    ]),
    status ? h("p", { className: "dash-note", role: "status", key: "status" }, status) : null,
  ]);
}
