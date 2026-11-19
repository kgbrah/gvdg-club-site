// The signed-in member's PDGA membership (GET /pdga/membership), for the Account page and, when it needs attention,
// Home.
import React from "react";
import { requestJson, storageGet, TOKEN_KEY } from "./api.js";

export function usePdgaMembership() {
  const [data, setData] = React.useState(null);
  React.useEffect(() => {
    const token = storageGet(TOKEN_KEY);
    if (!token) return undefined;
    const controller = new AbortController();
    requestJson("/pdga/membership", { signal: controller.signal, token }).then(setData).catch(() => {});
    return () => controller.abort();
  }, []);
  return data;
}
