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

function themeRoot() {
  return document.getElementById("members");
}

function Slider({ name, value, disabled, onChange }) {
  const limit = ADJUSTMENT_LIMITS[name];
  return h("label", { className: "aether-slider", key: name }, [
    h("span", { className: "aether-slider-label", key: "label" }, [
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

  const paint = React.useCallback((next) => {
    const safe = sanitizeTheme(next);
    setTheme(safe);
    if (safe) {
      setExtractMode(safe.extractMode);
      setMode(safe.mode);
      setAdjustments(sanitizeAdjustments(safe.adjustments));
    }
    applyDashboardTheme(safe, themeRoot());
    return safe;
  }, []);

  React.useEffect(() => {
    if (!token) return undefined;
    const local = readStoredTheme(window.localStorage, memberId);
    if (local) paint(local);
    const controller = new AbortController();
    request("/me/dashboard-theme", { token, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        const remote = sanitizeTheme(data?.theme);
        if (remote) {
          writeStoredTheme(window.localStorage, memberId, remote);
          paint(remote);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [token, memberId, paint]);

  const persistTimer = React.useRef(0);

  async function persist(next, immediate = true) {
    writeStoredTheme(window.localStorage, memberId, next);
    if (!token) return;
    const send = () => request("/me/dashboard-theme", {
      token,
      method: next ? "PUT" : "DELETE",
      body: next ? { theme: next } : undefined,
    }).catch(() => null);
    window.clearTimeout(persistTimer.current);
    if (immediate) {
      await send();
      return;
    }
    persistTimer.current = window.setTimeout(send, 400);
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
      : (preset ? null : pixelsRef.current);
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
      const pixels = pixelsRef.current || (theme?.wallpaper ? await pixelsFromDataUrl(theme.wallpaper) : null);
      pixelsRef.current = pixels;
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
      await compose({ nextMode, editedPalette: null });
    } finally {
      setBusy(false);
    }
  }

  async function changeExtract(nextExtract) {
    setExtractMode(nextExtract);
    if (!theme && !pixelsRef.current) return;
    setBusy(true);
    try {
      const pixels = pixelsRef.current || (theme?.wallpaper ? await pixelsFromDataUrl(theme.wallpaper) : null);
      pixelsRef.current = pixels;
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
    await persist(theme);
    setStatus("Theme applied to your dashboard.");
  }

  async function reset() {
    pixelsRef.current = null;
    paint(null);
    setExtractMode("normal");
    setMode("dark");
    setAdjustments(DEFAULT_ADJUSTMENTS);
    clearStoredTheme(window.localStorage, memberId);
    await persist(null);
    setStatus("Club default restored.");
  }

  if (!token) return null;

  const contrast = themeContrast(theme);
  const presetNames = Object.keys(PRESET_THEMES);

  return h("details", {
    className: "aether-theme dash-collapse",
    "data-react-dashboard-theme": theme ? "custom" : "default",
    open: true,
  }, [
    h("summary", { className: "dash-subtitle dash-collapse-summary", key: "summary" }, "Aether theme"),
    h("p", { className: "dash-note", key: "copy" }, "Aether for Omarchy, for this dashboard: drop a wallpaper, Extract a 16-color ANSI palette, fine-tune, Apply Theme."),
    h("div", { className: "aether-studio", key: "studio" }, [
      h("header", { className: "aether-header", key: "header" }, [
        h("strong", { className: "aether-mark", key: "mark" }, "AETHER"),
        h("div", { className: "aether-toggle", key: "look", role: "group", "aria-label": "Look" }, [
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
      h("div", { className: "aether-body", key: "body" }, [
        h("div", { className: "aether-main", key: "main" }, [
          h("label", {
            className: `aether-drop${dragging ? " is-dragging" : ""}${theme?.wallpaper ? " has-wallpaper" : ""}`,
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
              ? h("img", { className: "aether-wallpaper", src: theme.wallpaper, alt: "Dashboard wallpaper preview", key: "img" })
              : h("span", { className: "aether-drop-copy", key: "empty" }, "Drop a wallpaper or choose an image"),
            h("input", {
              id: "dashboardThemeFile",
              className: "aether-file",
              type: "file",
              accept: "image/jpeg,image/png,image/webp",
              disabled: busy,
              ref: fileRef,
              onChange: onFile,
              key: "file",
            }),
          ]),
          theme?.palette?.length
            ? h("div", { className: "aether-palette", key: "palette", "aria-label": "ANSI palette" },
              theme.palette.map((hex, index) => h("label", {
                className: "aether-swatch",
                key: `${hex}-${index}`,
                title: `${ANSI_SLOT_ROLES[index] || index} ${hex}`,
                style: { background: hex },
              }, [
                h("span", { className: "aether-swatch-role", key: "role" }, ANSI_SLOT_ROLES[index] || String(index)),
                h("input", {
                  type: "color",
                  value: hex,
                  "aria-label": `${ANSI_SLOT_ROLES[index] || "Color"} ${index}`,
                  onChange: (event) => recolor(index, event.target.value),
                  key: "color",
                }),
              ])))
            : h("p", { className: "aether-empty", key: "empty-palette" }, "Extract to fill the 16-color ANSI grid."),
        ]),
        h("aside", { className: "aether-sidebar", key: "sidebar" }, [
          EXTRACT_MODE_GROUPS.map((group) => h("div", { className: "aether-mode-group", key: group.id }, [
            h("span", { className: "aether-field", key: "label" }, group.label),
            h("div", { className: "aether-pills", key: "pills" }, group.modes.map((name) => h("button", {
              type: "button",
              className: extractMode === name ? "is-active" : "",
              title: EXTRACT_MODE_META[name]?.description,
              disabled: busy,
              onClick: () => changeExtract(name),
              key: name,
            }, EXTRACT_MODE_META[name]?.label || name))),
          ])),
          h("div", { className: "aether-adjust", key: "tune" }, [
            h("span", { className: "aether-field", key: "label" }, "Adjust"),
            h("div", { className: "aether-sliders", key: "sliders" }, ADJUSTMENT_KEYS.map((name) => h(Slider, {
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
            ? h("p", { className: "aether-contrast", key: "contrast" }, `Text contrast ${contrast.ratio.toFixed(1)}:1 ${contrast.grade}`)
            : null,
          h("div", { className: "aether-presets", key: "presets" }, [
            h("span", { className: "aether-field", key: "label" }, "Presets"),
            h("div", { className: "aether-preset-grid", key: "grid" }, presetNames.map((name) => h("button", {
              type: "button",
              className: `aether-preset${theme?.preset === name ? " is-active" : ""}`,
              disabled: busy,
              onClick: () => applyPreset(name),
              key: name,
            }, [
              h("span", { className: "aether-preset-name", key: "name" }, name),
              h("span", { className: "aether-preset-bar", key: "bar" }, PRESET_THEMES[name].slice(0, 8).map((hex, index) => h("i", {
                key: `${name}-${index}`,
                style: { background: hex },
              }))),
            ]))),
          ]),
        ]),
      ]),
      h("footer", { className: "aether-actionbar", key: "bar" }, [
        h("div", { className: "aether-actions", key: "actions" }, [
          h("button", {
            type: "button",
            className: "board-link",
            disabled: busy,
            onClick: extract,
            "data-aether-extract": "1",
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
          className: "passkey-btn aether-apply",
          disabled: busy,
          onClick: applyTheme,
          "data-aether-apply": "1",
          key: "apply",
        }, "Apply Theme"),
      ]),
    ]),
    status ? h("p", { className: "dash-note", role: "status", key: "status" }, status) : null,
  ]);
}
