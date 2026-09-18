// Shared accessibility helpers for React overlays.
// Vanilla-era spec (docs/superpowers/specs/2026-07-05-batch3-slice1-a11y-foundation-design.md)
// assumed window.GVDGa11y + body-level overlays. Route bundles now own the dialogs;
// this module is the React-era equivalent: live-region announcer + focus/isolation hook.
import React from "react";

const ANNOUNCER_ID = "gvdg-a11y-announcer";
const ANNOUNCE_DELAY_MS = 140;
const FOCUSABLE = [
  "a[href]:not([tabindex='-1'])",
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled]):not([tabindex='-1'])",
  "select:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled]):not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const polite = { queue: [], busy: false };
const assertive = { queue: [], busy: false };

function hasInert() {
  return typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype;
}

function ensureAnnouncer() {
  if (typeof document === "undefined") return null;
  let root = document.getElementById(ANNOUNCER_ID);
  if (root) return root;
  root = document.createElement("div");
  root.id = ANNOUNCER_ID;
  root.setAttribute("data-a11y-announcer", "true");
  const politeRegion = document.createElement("div");
  politeRegion.setAttribute("aria-live", "polite");
  politeRegion.setAttribute("aria-atomic", "true");
  politeRegion.setAttribute("data-a11y-live", "polite");
  const assertiveRegion = document.createElement("div");
  assertiveRegion.setAttribute("aria-live", "assertive");
  assertiveRegion.setAttribute("aria-atomic", "true");
  assertiveRegion.setAttribute("data-a11y-live", "assertive");
  root.append(politeRegion, assertiveRegion);
  document.body.append(root);
  return root;
}

function regionFor(assertiveLive) {
  const root = ensureAnnouncer();
  if (!root) return null;
  return root.querySelector(assertiveLive ? '[data-a11y-live="assertive"]' : '[data-a11y-live="polite"]');
}

function pump(store, assertiveLive) {
  if (store.busy || !store.queue.length) return;
  const region = regionFor(assertiveLive);
  if (!region) {
    store.queue.length = 0;
    return;
  }
  store.busy = true;
  const text = store.queue.shift();
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = text;
    window.setTimeout(() => {
      store.busy = false;
      pump(store, assertiveLive);
    }, ANNOUNCE_DELAY_MS);
  }, ANNOUNCE_DELAY_MS);
}

export function announce(message, { assertive: assertiveLive = false } = {}) {
  const text = String(message || "").trim();
  if (!text || typeof document === "undefined") return;
  const store = assertiveLive ? assertive : polite;
  store.queue.push(text);
  pump(store, assertiveLive);
}

function focusables(panel) {
  if (!panel) return [];
  return [...panel.querySelectorAll(FOCUSABLE)].filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.closest("[disabled],[aria-hidden='true']")) return false;
    return node.offsetParent !== null || node === document.activeElement;
  });
}

function overlayZIndex(node) {
  if (!node || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 0;
  const raw = window.getComputedStyle(node).zIndex;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

function isA11yOverlay(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.getAttribute("data-a11y-overlay") === "true") return true;
  const classes = node.classList;
  if (!classes) return false;
  if (classes.contains("overlay")) return true;
  for (const name of classes) {
    if (name.endsWith("-overlay")) return true;
  }
  return false;
}

function isOverlayAbove(candidate, overlay) {
  if (!candidate || candidate === overlay || !isA11yOverlay(candidate)) return false;
  const candidateZ = overlayZIndex(candidate);
  const overlayZ = overlayZIndex(overlay);
  if (candidateZ !== overlayZ) return candidateZ > overlayZ;
  return Boolean(overlay.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function isTopmostOverlay(overlay) {
  if (!overlay || !overlay.isConnected || typeof document === "undefined") return false;
  for (const node of document.body.children) {
    if (node !== overlay && isOverlayAbove(node, overlay)) return false;
  }
  return isA11yOverlay(overlay);
}

function isolateSiblings(overlay, applied) {
  if (!overlay || typeof document === "undefined") return applied;
  const announcer = document.getElementById(ANNOUNCER_ID);
  const seen = new Set(applied.map((row) => row.node));
  const inertSupported = hasInert();
  for (const node of [...document.body.children]) {
    if (node === overlay || node === announcer) continue;
    if (node.contains(overlay)) continue;
    if (seen.has(node)) continue;
    // Nested dialogs portal as sibling overlays. The players sheet must not
    // inert a later confirm, or Remove / Leave never receive the tap.
    if (isA11yOverlay(node) && isOverlayAbove(node, overlay)) continue;
    if (inertSupported) {
      if (node.hasAttribute("inert")) continue;
      node.setAttribute("inert", "");
      applied.push({ node, kind: "inert" });
    } else {
      applied.push({
        node,
        kind: "fallback",
        ariaHidden: node.getAttribute("aria-hidden"),
        tabindex: node.getAttribute("tabindex"),
      });
      node.setAttribute("aria-hidden", "true");
      node.setAttribute("tabindex", "-1");
    }
  }
  return applied;
}

function clearIsolation(applied) {
  for (const row of applied) {
    if (!row.node) continue;
    if (row.kind === "inert") {
      row.node.removeAttribute("inert");
    } else {
      if (row.ariaHidden == null) row.node.removeAttribute("aria-hidden");
      else row.node.setAttribute("aria-hidden", row.ariaHidden);
      if (row.tabindex == null) row.node.removeAttribute("tabindex");
      else row.node.setAttribute("tabindex", row.tabindex);
    }
  }
  applied.length = 0;
}

function isFocusable(node) {
  return Boolean(node && typeof node.focus === "function" && node.isConnected);
}

export function useAccessibleDialog({
  open,
  onClose,
  labelledBy,
  label,
  closeOnBackdrop = true,
} = {}) {
  const overlayRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const onCloseRef = React.useRef(onClose);
  const [isolated, setIsolated] = React.useState(false);
  onCloseRef.current = onClose;

  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const overlay = overlayRef.current;
    if (!overlay) return undefined;
    overlay.setAttribute("data-a11y-overlay", "true");
    return () => overlay.removeAttribute("data-a11y-overlay");
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      setIsolated(false);
      return undefined;
    }
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return undefined;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const applied = isolateSiblings(overlay, []);
    setIsolated(applied.length > 0);

    const observer = new MutationObserver(() => {
      isolateSiblings(overlay, applied);
    });
    observer.observe(document.body, { childList: true });

    const heading = labelledBy ? document.getElementById(labelledBy) : null;
    if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    const focusTarget = heading || panel;
    if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");

    function moveFocus() {
      try {
        focusTarget.focus();
      } catch {
        /* ignore unfocusable heading */
      }
    }
    if (panel.offsetParent !== null) moveFocus();
    else window.requestAnimationFrame(moveFocus);

    const accessibleName = label || (heading && heading.textContent) || "Dialog";
    announce(accessibleName, { assertive: true });

    function close() {
      if (typeof onCloseRef.current === "function") onCloseRef.current();
    }

    function onKeyDown(event) {
      if (!isTopmostOverlay(overlay)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(panel);
      if (!items.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onBackdrop(event) {
      if (!isTopmostOverlay(overlay)) return;
      if (closeOnBackdrop && event.target === overlay) close();
    }

    function onPageHide() {
      try {
        clearIsolation(applied);
      } finally {
        document.body.style.overflow = previousOverflow;
      }
    }

    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      observer.disconnect();
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pagehide", onPageHide);
      try {
        clearIsolation(applied);
      } finally {
        document.body.style.overflow = previousOverflow;
        setIsolated(false);
      }
      if (isFocusable(opener)) {
        try {
          opener.focus();
        } catch {
          /* opener may have been disabled */
        }
      }
    };
  }, [open, labelledBy, label, closeOnBackdrop]);

  return { overlayRef, panelRef, isolated };
}
