import React from "react";

import { resolveApiBase } from "./api-base.js";
import { projectMapPoint } from "./hole-map-model.js";
import { readMemberToken } from "./member-session.js";

const h = React.createElement;

export const HEATMAP_MIN_SAMPLES = 3;
export const HEATMAP_SCALE = 4;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function splatHeatmap(width, height, points, { sigma = 12 } = {}) {
  const w = Math.max(1, Math.round(width));
  const hh = Math.max(1, Math.round(height));
  const data = new Float32Array(w * hh);
  const radius = Math.max(2, Math.ceil(sigma * 2.4));
  const twoSigma = 2 * sigma * sigma;
  let max = 0;
  for (const point of Array.isArray(points) ? points : []) {
    const px = finite(point && point.x);
    const py = finite(point && point.y);
    if (px == null || py == null) continue;
    const x0 = Math.max(0, Math.floor(px - radius));
    const x1 = Math.min(w - 1, Math.ceil(px + radius));
    const y0 = Math.max(0, Math.floor(py - radius));
    const y1 = Math.min(hh - 1, Math.ceil(py + radius));
    for (let y = y0; y <= y1; y += 1) {
      const dy = y - py;
      for (let x = x0; x <= x1; x += 1) {
        const dx = x - px;
        const weight = Math.exp(-(dx * dx + dy * dy) / twoSigma);
        const i = y * w + x;
        data[i] += weight;
        if (data[i] > max) max = data[i];
      }
    }
  }
  return { data, max, width: w, height: hh };
}

export function colorizeHeatmap(imageData, grid, { alpha = 0.7 } = {}) {
  if (!imageData || !grid || !grid.max) return imageData;
  const pixels = imageData.data;
  const { data, max, width, height } = grid;
  for (let i = 0; i < width * height; i += 1) {
    const t = data[i] / max;
    if (t <= 0.04) continue;
    const o = i * 4;
    const hot = Math.min(1, Math.max(0, (t - 0.18) / 0.82));
    pixels[o] = Math.round(184 + (232 - 184) * hot);
    pixels[o + 1] = Math.round(149 + (70 - 149) * hot);
    pixels[o + 2] = Math.round(64 + (48 - 64) * hot);
    pixels[o + 3] = Math.round(40 + (alpha * 220 - 40) * Math.min(1, t * 1.35));
  }
  return imageData;
}

export function projectHeatPoints(map, points) {
  return (Array.isArray(points) ? points : []).flatMap((row) => {
    const pt = projectMapPoint(map, row && row.lat, row && row.lng);
    if (!pt) return [];
    return [{ x: pt.x, y: pt.y, n: Number(row && row.n) || 1 }];
  });
}

export function heatmapPayloadOk(payload) {
  if (!payload || typeof payload !== "object") return false;
  return Array.isArray(payload.lies) || Array.isArray(payload.you);
}

const cache = new Map();

export async function fetchHoleHeatmap(layoutId, hole, { apiBase, token } = {}) {
  const id = Number(layoutId);
  const n = Number(hole);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n < 1) return null;
  const base = String(apiBase || resolveApiBase()).replace(/\/+$/, "");
  const signedIn = Boolean(token);
  const key = id + ":" + n + ":pub";
  if (!signedIn && cache.has(key)) return cache.get(key);
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(base + "/layouts/" + encodeURIComponent(String(id)) + "/heatmap?hole=" + encodeURIComponent(String(n)), {
    headers,
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!heatmapPayloadOk(data)) return null;
  if (!signedIn) cache.set(key, data);
  return data;
}

export function useHoleHeatmap(layoutId, hole) {
  const [data, setData] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    setData(null);
    const id = Number(layoutId);
    const n = Number(hole);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n < 1) return undefined;
    fetchHoleHeatmap(id, n, { token: readMemberToken() || "" })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [layoutId, hole]);
  return data;
}

export function HeatmapLayer({ map, payload, enabled }) {
  const canvasRef = React.useRef(null);
  const points = payload && Array.isArray(payload.lies) ? payload.lies : [];
  const you = payload && Array.isArray(payload.you) ? payload.you : [];
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map || !enabled) return;
    const width = Math.max(1, Math.round(map.width / HEATMAP_SCALE));
    const height = Math.max(1, Math.round(map.height / HEATMAP_SCALE));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const projected = projectHeatPoints(map, points).map((pt) => ({
      x: pt.x / HEATMAP_SCALE,
      y: pt.y / HEATMAP_SCALE,
    }));
    if (projected.length < HEATMAP_MIN_SAMPLES) return;
    const grid = splatHeatmap(width, height, projected, { sigma: Math.max(6, 18 / HEATMAP_SCALE) });
    const image = ctx.createImageData(width, height);
    colorizeHeatmap(image, grid);
    ctx.putImageData(image, 0, 0);
  }, [map, payload, enabled, points]);
  if (!enabled || !map) return null;
  const youMarks = projectHeatPoints(map, you);
  const showCanvas = points.length >= HEATMAP_MIN_SAMPLES;
  return [
    showCanvas
      ? h("canvas", {
        "aria-hidden": "true",
        className: "hole-map-heat",
        key: "heat-canvas",
        ref: canvasRef,
      })
      : null,
    youMarks.length
      ? h(
        "svg",
        {
          "aria-hidden": "true",
          className: "hole-map-heat-you",
          key: "you",
          preserveAspectRatio: "xMidYMid meet",
          viewBox: `0 0 ${map.width} ${map.height}`,
        },
        youMarks.map((mark, index) =>
          h("circle", {
            className: "hole-map-heat-you-dot",
            cx: mark.x,
            cy: mark.y,
            key: "you-" + index,
            r: 5.5,
          }),
        ),
      )
      : null,
  ];
}
