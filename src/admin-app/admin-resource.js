import React from "react";

import { adminJson } from "./admin-api.js";

/** GET an admin JSON resource; `revision` re-reads it. Stale responses for an old path or token are dropped. */
export function useAdminResource(path, token, revision = 0) {
  const [state, setState] = React.useState({ path: "", status: "loading", data: null });
  React.useEffect(() => {
    if (!path || !token) return undefined;
    const controller = new AbortController();
    setState({ path, token, status: "loading", data: null });
    adminJson(path, { token, signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ path, token, status: "ready", data });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ path, token, status: "error", data: null });
    });
    return () => controller.abort();
  }, [path, token, revision]);
  return state.path === path && state.token === token ? state : { status: "loading", data: null };
}
