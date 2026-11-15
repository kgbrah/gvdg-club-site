import React from "react";

import { coursePackStore } from "../shared/course-packs.js";
import { COVERAGE_LABELS, layoutRows, mappedHole } from "../shared/course-quality.js";
import { projectHoleMap } from "../shared/hole-map-model.js";

const h = React.createElement;

const PACK_ERRORS = {
  "storage-full": "Device storage is full. Remove a saved layout or free storage, then try again.",
  "storage-unavailable": "Saved course storage is unavailable in this browser.",
  "invalid-layout": "This layout has no available hole data to save.",
  "could-not-confirm": "The browser did not confirm the change. Check your saved layouts and try again.",
};

export function useCoursePacks() {
  const [result, setResult] = React.useState({ loading: true, packs: [] });
  const refresh = React.useCallback(async () => {
    setResult(await coursePackStore.list());
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    coursePackStore.list().then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => { cancelled = true; };
  }, []);
  return { ...result, refresh };
}

export function coursePackDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "";
  const date = new Date(value.slice(0, 10) + "T12:00:00Z");
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date) : "";
}

function SchematicHole({ hole }) {
  const map = mappedHole(hole) ? projectHoleMap(hole, { width: 400, height: 210 }) : null;
  if (!map) return h("p", { className: "muted" }, "Tee and basket positions are needed for a schematic.");
  const { tee, basket, width, height } = map;
  function marker(point, caption, key) {
    const right = point.x <= width * 0.62;
    return h("g", { key }, [
      h("circle", { key: "dot", r: 7, cx: point.x, cy: point.y, fill: "currentColor" }),
      h("text", { key: "label", x: point.x + (right ? 13 : -13), y: point.y - 8,
        textAnchor: right ? "start" : "end", fill: "currentColor", fontSize: 15 }, caption),
    ]);
  }
  return h("svg", {
    style: { display: "block", width: "100%", border: "1px solid currentColor", borderRadius: ".75rem" },
    viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Hole " + hole.hole + " schematic facing north",
  }, [
    h("text", { key: "north", x: 14, y: 23, fill: "currentColor", fontSize: 15 }, "N ↑"),
    h("line", { key: "line", x1: tee.x, y1: tee.y, x2: basket.x, y2: basket.y,
      stroke: "currentColor", strokeDasharray: "4 5", opacity: 0.65 }),
    marker(tee, "Tee", "tee"),
    marker(basket, "Basket", "basket"),
  ]);
}

function startOfflineLink(pack) {
  return pack.quality.scorable ? h("a", { className: "btn secondary small", key: "start-offline",
    href: "score.html?offline=1&pack=" + encodeURIComponent(pack.key) }, "Start offline round") : null;
}

export function SavedLayoutPreview({ pack, onBack }) {
  const holes = layoutRows(pack.layout).filter((hole) => Number.isInteger(Number(hole?.hole)) && Number(hole.hole) >= 1 && Number(hole.hole) <= 36);
  const [selection, setSelection] = React.useState(0);
  const hole = holes[selection];
  const quality = pack.quality.holes.find((row) => row.hole === Number(hole?.hole));
  return h("div", { className: "stack" }, [
    h("button", { className: "btn ghost small", type: "button", onClick: onBack, key: "back" }, "Back"),
    h("h2", { className: "section", key: "title" }, pack.course.name),
    h("p", { className: "muted", key: "layout" }, pack.layout.name + " · Saved " + coursePackDate(pack.savedAt)),
    h("p", { className: "muted", key: "maps" }, pack.assets.schematicHoles + " of " + pack.quality.holeCount + " hole schematics. Straight-line reference, with no satellite imagery."),
    startOfflineLink(pack),
    holes.length ? h("label", { className: "lbl", key: "select" }, "Hole",
      h("select", { className: "field", "aria-label": "Hole", value: selection, onChange: (event) => setSelection(Number(event.target.value)) },
        holes.map((row, index) => h("option", { key: index, value: index }, "Hole " + row.hole)),
      )) : null,
    hole ? h(SchematicHole, { key: "map", hole }) : null,
    quality ? h("p", { className: "muted", key: "par" }, [
      quality.par == null ? "Par unavailable" : "Par " + quality.par + (quality.parSource === "placeholder" ? " (estimate)" : quality.parSource === "tee-sign" ? " (tee-sign approved)" : ""),
      hole.distance_ft != null ? " · " + hole.distance_ft + " ft" + (["par_estimate", "geo"].includes(hole.distance_source) ? " (estimate)" : "") : "",
    ].join("")) : null,
  ]);
}

export function PackLayoutActions({ course, layout, pack, refresh, onOpen, allowSave, busy, onBusy, onStatus }) {
  const outdated = pack && layout?.revision && pack.revision !== layout.revision;
  async function update(remove) {
    onBusy(true);
    const reply = remove ? await coursePackStore.remove(course.id, layout.id) : await coursePackStore.save(course, layout);
    if (reply.ok) {
      await refresh();
      onStatus(remove ? "Removed from this device." : "Layout and available schematics saved on this device.");
    } else {
      onStatus(PACK_ERRORS[reply.error] || "Could not update this saved layout.");
    }
    onBusy(false);
  }
  return h("div", { className: "stack", key: "pack" }, [
    pack ? h("p", { className: "muted", key: "summary" },
      "Saved " + coursePackDate(pack.savedAt) + " · " + pack.assets.schematicHoles + " hole schematics" + (outdated ? " · Update available" : "")) : null,
    h("div", { className: "course-map-holes", key: "actions" }, [
      allowSave && (!pack || outdated) ? h("button", { className: "btn secondary small", type: "button", disabled: busy, key: "save",
        onClick: () => update(false) }, outdated ? "Update saved layout" : "Save for offline") : null,
      pack ? h("button", { className: "btn ghost small", type: "button", key: "open", onClick: () => onOpen(pack) }, "Open saved layout") : null,
      pack ? startOfflineLink(pack) : null,
      pack ? h("button", { className: "btn ghost small", type: "button", disabled: busy, key: "remove", onClick: () => update(true) }, "Remove download") : null,
    ]),
  ]);
}

export function SavedCoursesView({ onBack }) {
  const { loading, packs, error, unreadable, refresh } = useCoursePacks();
  const [active, setActive] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  if (active) return h(SavedLayoutPreview, { pack: active, key: active.key, onBack: () => setActive(null) });
  return h("div", { className: "stack" }, [
    h("button", { className: "btn ghost small", type: "button", onClick: onBack, key: "back" }, "Back"),
    h("h2", { className: "section", key: "title" }, "Saved course layouts"),
    loading ? h("p", { role: "status", key: "loading" }, "Reading saved layouts…") : null,
    error ? h("p", { className: "muted", role: "status", key: "error" }, PACK_ERRORS[error] || "Could not read saved layouts.") : null,
    !loading && !error && !packs.length ? h("p", { className: "muted", key: "empty" }, "Open a course’s layout list to save a layout for offline use.") : null,
    unreadable ? h("p", { className: "muted", key: "unreadable" }, "Some saved layouts could not be read. Save those layouts again when connected.") : null,
    ...packs.map((pack) => h("section", { className: "card stack", key: pack.key }, [
      h("h3", { className: "section", key: "title" }, pack.course.name + " · " + pack.layout.name),
      h("p", { className: "muted", key: "coverage" }, COVERAGE_LABELS[pack.quality.status]),
      h(PackLayoutActions, { key: "pack", course: pack.course, layout: pack.layout, pack, refresh, busy, onBusy: setBusy, onOpen: setActive, onStatus: setStatus }),
    ])),
    h("p", { className: "muted", role: "status", key: "status" }, status),
  ]);
}
