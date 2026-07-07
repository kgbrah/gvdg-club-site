import React from "react";

const h = React.createElement;

const EMPTY_STATE = { status: "loading", destinations: [] };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function currentState() {
  const state = window.__gvdgAdminDataArchiveDestinationsState;
  return state && typeof state === "object" ? state : EMPTY_STATE;
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeDestination(destination) {
  const source = objectOrEmpty(destination);
  const id = source.id == null ? "" : String(source.id);
  const label = normalizeText(source.label, id ? `Endpoint ${id}` : "Endpoint");
  return {
    source,
    authHeader: normalizeText(source.auth_header, "(no auth header)") || "(no auth header)",
    authPrefix: normalizeText(source.auth_prefix, "(no auth prefix)") || "(no auth prefix)",
    endpointUrl: normalizeText(source.endpoint_url),
    hasAuthToken: source.hasAuthToken === true || source.has_auth_token === true,
    id,
    isActive: Number(source.is_active) === 1 || source.is_active === true,
    label,
  };
}

function normalizeState(state) {
  return {
    destinations: Array.isArray(state.destinations) ? state.destinations.map(normalizeDestination) : [],
    status: state.status === "loading" || state.status === "error" ? state.status : "ready",
  };
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function DestinationRow({ destination }) {
  function requestDelete() {
    if (!window.confirm(`Delete destination "${destination.label}"?`)) return;
    dispatchRequest("gvdg:admin-data-archive-destination-delete-request", { destination: destination.source });
  }

  const details = [
    destination.endpointUrl,
    destination.authHeader,
    destination.authPrefix,
    destination.hasAuthToken ? "token: set" : "token: not set",
  ].filter(Boolean).join(" - ");

  return h("div", { className: "admin-evrow", "data-admin-data-archive-destination-id": destination.id }, [
    h("div", { key: "details" }, [
      h("div", { className: "ev-name", key: "label" }, destination.label),
      h("div", { className: "al-note", key: "meta" }, details || "No endpoint details"),
      destination.isActive ? h("span", { className: "admin-msg ok", key: "active" }, "Active default") : null,
    ]),
    h("div", { className: "shop-admin-controls", key: "controls" }, [
      h("button", {
        className: "admin-btn secondary",
        key: "edit",
        onClick: () => dispatchRequest("gvdg:admin-data-archive-destination-edit-request", { destination: destination.source }),
        type: "button",
      }, "Edit"),
      destination.isActive ? null : h("button", {
        className: "admin-btn",
        key: "activate",
        onClick: () => dispatchRequest("gvdg:admin-data-archive-destination-activate-request", { destination: destination.source }),
        type: "button",
      }, "Make active"),
      h("button", {
        className: "admin-btn danger",
        key: "delete",
        onClick: requestDelete,
        type: "button",
      }, "Delete"),
    ]),
  ]);
}

export function AdminDataArchiveDestinationsList() {
  const [state, setState] = React.useState(() => normalizeState(currentState()));

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : currentState()));
    }
    window.addEventListener("gvdg:admin-data-archive-destinations-list", update);
    setState(normalizeState(currentState()));
    return () => window.removeEventListener("gvdg:admin-data-archive-destinations-list", update);
  }, []);

  if (state.status === "loading") {
    return h("p", { className: "al-note", "data-react-admin-data-archive-destinations": "loading", role: "status" }, "Loading...");
  }

  if (state.status === "error") {
    return h("p", { className: "al-note err", "data-react-admin-data-archive-destinations": "error", role: "alert" }, "Unable to load destinations.");
  }

  if (!state.destinations.length) {
    return h("p", { className: "al-note", "data-react-admin-data-archive-destinations": "empty", role: "status" }, "No destinations yet. Add one above to send archived snapshots.");
  }

  return h("div", { "data-react-admin-data-archive-destinations": "ready" }, state.destinations.map((destination, index) => (
    h(DestinationRow, {
      destination,
      key: destination.id || `${destination.label}-${index}`,
    })
  )));
}
