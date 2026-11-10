import React from "react";

// A refresh that reports "loading" should not unmount the list already on screen.
// A different scope (filter, queue) still shows loading so stale rows are not
// left under a new query.
export function settleWhileLoading(previous, state, scopeKey) {
  const hold = Boolean(
    state
    && state.status === "loading"
    && previous
    && previous.scopeKey === scopeKey
    && previous.state
    && previous.state.status !== "loading",
  );
  if (hold) return { held: true, snapshot: previous, view: previous.state };
  return { held: false, snapshot: { scopeKey, state }, view: state };
}

export function useSettledWhileLoading(state, scope) {
  const kept = React.useRef(null);
  const scopeKey = scope == null ? "" : String(scope);
  const next = settleWhileLoading(kept.current, state, scopeKey);
  if (!next.held) kept.current = next.snapshot;
  return next.view;
}
