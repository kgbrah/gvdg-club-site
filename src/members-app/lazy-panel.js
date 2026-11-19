import React from "react";

const h = React.createElement;
const RELOAD_KEY = "gvdg:screen-reload-at";

// A screen's code that won't load while the device is online almost always means the app was updated while this page
// was open, or the network blinked mid-deploy. The browser keeps a failed module for the rest of the page, so only a
// reload fetches it fresh; it returns to the same screen (the route is in the URL). At most once a minute, so a real
// outage shows the message instead of reloading over and over.
function reloadForFreshCode() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// Screens that are not on the first view load their code on demand. Each one keeps its loaded component
// in module scope, so a screen that has loaded once renders straight away from then on.
export function lazyPanel(load, exportName) {
  let Component = null;
  let pending = null;

  function preload() {
    if (Component) return Promise.resolve(Component);
    if (!pending) {
      pending = load().then((module) => {
        const loaded = module[exportName];
        if (typeof loaded !== "function") throw new Error(`Missing ${exportName}`);
        Component = loaded;
        return loaded;
      }, (error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  }

  function LazyPanel(props) {
    const ready = useLoaded([LazyPanel]);
    if (ready.status === "ready") return h(Component, props);
    return h(PanelPlaceholder, ready);
  }

  LazyPanel.displayName = `Lazy(${exportName})`;
  LazyPanel.preload = preload;
  LazyPanel.loaded = () => Boolean(Component);
  return LazyPanel;
}

// One placeholder for a screen built from several lazy parts, so they appear together.
export function LazyGroup({ panels, children }) {
  const ready = useLoaded(panels);
  return ready.status === "ready" ? children() : h(PanelPlaceholder, ready);
}

function useLoaded(panels) {
  const done = panels.every((panel) => panel.loaded());
  const [state, setState] = React.useState({ attempt: 0, failed: false });
  React.useEffect(() => {
    if (done || state.failed) return undefined;
    let live = true;
    Promise.all(panels.map((panel) => panel.preload())).then(
      () => { if (live) setState((current) => ({ ...current })); },
      () => {
        if (!live) return;
        if (reloadForFreshCode()) return;
        setState((current) => ({ ...current, failed: true }));
      },
    );
    return () => { live = false; };
    // The panel list is fixed per call site, so it is not a dependency; a retry bumps the attempt.
  }, [done, state.failed, state.attempt]);
  if (done) return { status: "ready" };
  if (!state.failed) return { status: "loading" };
  return {
    status: "error",
    attempt: state.attempt,
    // Online, only a reload can fetch the screen again (the browser keeps the failed module). Offline, retry in place
    // so it works the moment the connection is back; a second failure reloads.
    onRetry: () => (navigator.onLine !== false || state.attempt > 0 ? window.location.reload() : setState({ attempt: state.attempt + 1, failed: false })),
  };
}

function PanelPlaceholder({ status, onRetry }) {
  if (status === "error") {
    return h("div", { className: "member-panel-loading member-panel-load-error", role: "alert" }, [
      h("p", { className: "dash-note", key: "note" }, "This screen didn’t load. Check your connection and try again."),
      h("button", { className: "player-btn", type: "button", onClick: onRetry, key: "retry" }, "Try again"),
    ]);
  }
  return h("div", { className: "member-panel-loading", role: "status", "aria-busy": "true", "aria-label": "Loading", "data-member-panel-loading": "true" }, [
    h("span", { key: "a" }),
    h("span", { key: "b" }),
    h("span", { key: "c" }),
  ]);
}

// After the first screen has settled, fetch the code for the main tabs in idle time so a first tap
// on them does not wait on the network. Nothing is mounted; the modules are only loaded.
export function warmPanels(panels) {
  // A member who asked the browser to save data gets each screen's code only when they open it.
  if (navigator.connection?.saveData) return undefined;
  let cancelled = false;
  let timer = 0;
  const idle = (callback) => (typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback(callback, { timeout: 4000 })
    : window.setTimeout(callback, 600));
  function next(index) {
    if (cancelled || index >= panels.length) return;
    idle(() => {
      if (cancelled) return;
      panels[index].preload().catch(() => {}).finally(() => next(index + 1));
    });
  }
  function start() {
    timer = window.setTimeout(() => next(0), 2500);
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    window.removeEventListener("load", start);
  };
}
