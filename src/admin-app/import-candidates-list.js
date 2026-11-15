import React from "react";

import { useSettledWhileLoading } from "../shared/settled-state.js";

const h = React.createElement;

const EMPTY_STATE = { sourceUrl: "", standings: [], status: "idle", candidates: [] };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeCandidate(candidate, index) {
  const source = objectOrEmpty(candidate);
  const name = normalizeText(source.name);
  const date = normalizeText(source.date);
  const type = normalizeText(source.type, "event") || "event";
  return {
    date,
    key: `${name || "candidate"}-${date || "no-date"}-${index}`,
    name,
    source,
    type,
  };
}

function normalizeStanding(standing, index) {
  const source = objectOrEmpty(standing);
  const name = normalizeText(source.name);
  return {
    events: Number(source.events) || 0,
    key: `${name || "player"}-${index}`,
    name,
    points: Number(source.points) || 0,
    wins: Number(source.wins) || 0,
  };
}

function normalizeState(state) {
  return {
    candidates: Array.isArray(state.candidates) ? state.candidates.map(normalizeCandidate) : [],
    sourceUrl: normalizeText(state.sourceUrl),
    standings: Array.isArray(state.standings) ? state.standings.map(normalizeStanding).filter((row) => row.name) : [],
    status: state.status === "loading" ? "loading" : state.status === "ready" ? "ready" : "idle",
  };
}

function candidateLabel(candidate) {
  const venue = normalizeText(candidate.source.venue);
  const scored = Number(candidate.source.result_count);
  const scores = Number.isFinite(scored) && scored > 0 ? ` · ${scored} scores` : "";
  return `${candidate.name || "?"}${candidate.date ? ` (${candidate.date})` : ""}${venue ? ` · ${venue}` : ""}${scores} [${candidate.type}]`;
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function AdminImportCandidatesList() {
  const [state, setState] = React.useState(() => normalizeState(EMPTY_STATE));
  const [actions, setActions] = React.useState({});
  const [saveState, setSaveState] = React.useState("idle");
  const requestCounter = React.useRef(0);

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_STATE));
      setActions({});
      setSaveState("idle");
    }
    window.addEventListener("gvdg:admin-import-candidates", update);
    return () => window.removeEventListener("gvdg:admin-import-candidates", update);
  }, []);

  React.useEffect(() => {
    function updateAction(event) {
      const detail = objectOrEmpty(event.detail);
      const requestId = normalizeText(detail.requestId);
      if (!requestId) return;
      setActions((current) => ({ ...current, [requestId]: detail.ok === true ? "created" : "failed" }));
    }
    window.addEventListener("gvdg:admin-import-candidate-create-result", updateAction);
    return () => window.removeEventListener("gvdg:admin-import-candidate-create-result", updateAction);
  }, []);

  React.useEffect(() => {
    function updateSave(event) {
      const detail = objectOrEmpty(event.detail);
      if (!detail.requestId) return;
      setSaveState(detail.ok === true ? "saved" : "failed");
    }
    window.addEventListener("gvdg:admin-udisc-save-result", updateSave);
    return () => window.removeEventListener("gvdg:admin-udisc-save-result", updateSave);
  }, []);

  const view = useSettledWhileLoading(state);

  if (view.status === "idle") return null;
  if (view.status === "loading") {
    return h("p", { className: "dash-note", "data-react-admin-import-candidates": "loading", role: "status" }, "Loading candidates...");
  }
  if (!view.candidates.length && !view.standings.length) {
    return h("p", { className: "dash-note", "data-react-admin-import-candidates": "empty", role: "status" }, "No candidates found.");
  }

  function requestCreate(candidate) {
    const requestId = `${candidate.key}-${requestCounter.current += 1}`;
    setActions((current) => ({ ...current, [requestId]: "creating" }));
    dispatchRequest("gvdg:admin-import-candidate-create-request", { candidate: candidate.source, requestId });
  }

  function actionState(candidate) {
    const current = Object.entries(actions).find(([requestId]) => requestId.startsWith(`${candidate.key}-`));
    return current ? current[1] : "idle";
  }

  function requestSave() {
    setSaveState("saving");
    dispatchRequest("gvdg:admin-udisc-save-request", { requestId: `udisc-save-${requestCounter.current += 1}`, url: view.sourceUrl });
  }

  const standings = view.standings.length
    ? h("div", { className: "admin-cand", key: "standings" }, [
      h("div", { key: "copy" }, [
        h("strong", { key: "title" }, "Current UDisc standings"),
        h("p", { className: "dash-note", key: "note" }, "Past rounds are included. Saving writes the scores and this season table onto the league page. Points follow UDisc, including only the rounds it keeps."),
        h("ol", { key: "list" }, view.standings.slice(0, 12).map((row, index) => h("li", { key: row.key }, `${index + 1}. ${row.name} · ${row.points} pts · ${row.events} rounds`))),
      ]),
      h("button", {
        className: "admin-btn",
        disabled: saveState === "saving" || saveState === "saved" || !view.sourceUrl,
        key: "save",
        id: "udiscSaveResultsBtn",
        onClick: requestSave,
        type: "button",
      }, saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : saveState === "failed" ? "Save failed" : "Save results and standings"),
    ])
    : null;

  return h("div", { "data-react-admin-import-candidates": "ready" }, [
    standings,
    ...view.candidates.map((candidate) => {
    const status = actionState(candidate);
    const busy = status === "creating";
    return h("div", { className: "admin-cand", key: candidate.key }, [
      h("span", { key: "label" }, candidateLabel(candidate)),
      h("button", {
        className: "admin-btn secondary",
        disabled: busy || status === "created" || status === "failed" || !candidate.name,
        key: "create",
        onClick: () => requestCreate(candidate),
        type: "button",
      }, busy ? "Creating..." : status === "created" ? "Created" : status === "failed" ? "Failed" : "Create"),
    ]);
  }),
  ]);
}
