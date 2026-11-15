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
  return Boolean(node?.isConnected && typeof node.focus === "function" && node.getClientRects().length && !node.closest("[inert]"));
}

export function useAccessibleDialog({
  open,
  onClose,
  labelledBy,
  label,
  returnFocus,
  closeOnBackdrop = true,
} = {}) {
  const overlayRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const onCloseRef = React.useRef(onClose);
  const returnFocusRef = React.useRef(returnFocus);
  const [isolated, setIsolated] = React.useState(false);
  onCloseRef.current = onClose;
  returnFocusRef.current = returnFocus;

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
      const active = document.activeElement;
      const outsideTabOrder = !items.includes(active);
      if (event.shiftKey ? outsideTabOrder || active === first : outsideTabOrder || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }

    function onBackdrop(event) {
      if (!isTopmostOverlay(overlay)) return;
      if (closeOnBackdrop && event.target === overlay) close();
    }

    let swipeCleanup = () => {};
    if (closeOnBackdrop) {
      let startX = 0;
      let startY = 0;
      let startTime = 0;
      let tracking = false;
      let dragging = false;
      let blocked = false;
      let swallowClick = false;
      let settled = false;
      let dismissTimer = 0;

      function pullBlocked(startNode) {
        let el = startNode instanceof Element ? startNode : null;
        while (el) {
          const oy = window.getComputedStyle(el).overflowY;
          if ((oy === "auto" || oy === "scroll") && el.scrollTop > 1) return true;
          if (el === panel) break;
          el = el.parentElement;
        }
        return false;
      }

      function clearDrag() {
        tracking = false;
        dragging = false;
        panel.classList.remove("is-sheet-dragging");
        panel.style.transition = "";
        panel.style.transform = "";
      }

      function dismiss() {
        if (settled) return;
        settled = true;
        window.clearTimeout(dismissTimer);
        close();
      }

      function onStart(event) {
        if (!isTopmostOverlay(overlay) || event.touches.length !== 1) return;
        const target = event.target;
        if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
        const touch = event.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        startTime = event.timeStamp;
        tracking = true;
        dragging = false;
        blocked = pullBlocked(target);
      }

      function onMove(event) {
        if (!tracking || event.touches.length !== 1) return;
        const touch = event.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (!dragging) {
          if (blocked || dy < 8 || Math.abs(dx) > Math.abs(dy)) {
            if (blocked || dy < -8 || Math.abs(dx) > 10) tracking = false;
            return;
          }
          dragging = true;
          panel.classList.add("is-sheet-dragging");
          panel.style.transition = "none";
        }
        if (event.cancelable) event.preventDefault();
        panel.style.transform = "translateY(" + Math.max(0, dy) + "px)";
      }

      function onEnd(event) {
        if (!tracking) return;
        const touch = event.changedTouches && event.changedTouches[0];
        const dy = touch ? touch.clientY - startY : 0;
        const elapsed = Math.max(event.timeStamp - startTime, 1);
        const flung = dy > 36 && dy / elapsed > 0.65;
        const wasDragging = dragging;
        tracking = false;
        dragging = false;
        if (!wasDragging) return;
        swallowClick = true;
        if (dy > 96 || flung) {
          panel.style.transition = "transform 160ms ease";
          panel.style.transform = "translateY(110%)";
          panel.addEventListener("transitionend", dismiss, { once: true });
          dismissTimer = window.setTimeout(dismiss, 200);
          return;
        }
        panel.classList.remove("is-sheet-dragging");
        panel.style.transition = "transform 180ms ease";
        panel.style.transform = "";
      }

      function onCancel() {
        if (dragging) clearDrag();
        tracking = false;
      }

      function onClick(event) {
        if (!swallowClick) return;
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
      }

      panel.addEventListener("touchstart", onStart, { passive: true });
      panel.addEventListener("touchmove", onMove, { passive: false });
      panel.addEventListener("touchend", onEnd);
      panel.addEventListener("touchcancel", onCancel);
      panel.addEventListener("click", onClick, true);
      swipeCleanup = () => {
        settled = true;
        window.clearTimeout(dismissTimer);
        panel.removeEventListener("touchstart", onStart);
        panel.removeEventListener("touchmove", onMove);
        panel.removeEventListener("touchend", onEnd);
        panel.removeEventListener("touchcancel", onCancel);
        panel.removeEventListener("click", onClick, true);
        panel.removeEventListener("transitionend", dismiss);
        clearDrag();
      };
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
      swipeCleanup();
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
      const requested = returnFocusRef.current?.();
      const target = isFocusable(requested) ? requested : opener;
      if (isFocusable(target)) {
        try {
          target.focus({ preventScroll: true });
        } catch {
          /* opener may have been disabled */
        }
      }
    };
  }, [open, labelledBy, label, closeOnBackdrop]);

  return { overlayRef, panelRef, isolated };
}
