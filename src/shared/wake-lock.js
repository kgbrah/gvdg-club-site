export function createWakeLock({
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
} = {}) {
  let sentinel = null;
  let wanted = false;
  let listening = false;

  async function request() {
    if (!wanted) return null;
    const api = navigatorRef && navigatorRef.wakeLock;
    if (!api || typeof api.request !== "function") return null;
    try {
      const next = await api.request("screen");
      if (!wanted) {
        try { next?.release?.(); } catch { /* ignore */ }
        return null;
      }
      sentinel = next;
      if (sentinel && typeof sentinel.addEventListener === "function") {
        sentinel.addEventListener("release", () => {
          if (sentinel === next) sentinel = null;
        });
      }
      return sentinel;
    } catch {
      sentinel = null;
      return null;
    }
  }

  function onVisibility() {
    if (documentRef && documentRef.visibilityState === "visible") void request();
  }

  return {
    async start() {
      wanted = true;
      if (!listening && documentRef && typeof documentRef.addEventListener === "function") {
        documentRef.addEventListener("visibilitychange", onVisibility);
        listening = true;
      }
      if (sentinel) return sentinel;
      return request();
    },
    stop() {
      wanted = false;
      if (listening && documentRef && typeof documentRef.removeEventListener === "function") {
        documentRef.removeEventListener("visibilitychange", onVisibility);
        listening = false;
      }
      try { sentinel?.release?.(); } catch { /* ignore */ }
      sentinel = null;
    },
    get active() {
      return Boolean(sentinel);
    },
  };
}
