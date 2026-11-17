import React from "react";
import { createPortal } from "react-dom";
import { ImagePlus, Send, X } from "lucide-react";

import { useAccessibleDialog } from "./a11y.js";
import { resolveApiBase } from "./api-base.js";
import { sanitizeCrottsActions } from "./crotts-actions.js";
import { photoDataUrl, videoFrames } from "./ruling-media.js";

const h = React.createElement;
const AVATAR = "img/crotts.jpg";
export const CROTTS_HELP_EVENT = "gvdg:help-request";

const CROTTS_CSS = `
.crotts-overlay {
  position: fixed; z-index: 12000; left: 0; right: 0;
  top: var(--crotts-vv-top, 0px); bottom: var(--crotts-keyboard, 0px);
  display: grid; grid-template-rows: minmax(0, 1fr); justify-items: center; align-items: center;
  box-sizing: border-box;
  padding: max(.8rem, var(--safe-top)) .8rem max(.8rem, var(--safe-bottom));
  background: color-mix(in srgb, var(--member-chrome-bg) 66%, transparent);
  overscroll-behavior: contain;
}
body .crotts-overlay > #crotts-panel {
  box-sizing: border-box; display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(100%, 28rem); height: min(100%, 33rem); min-height: 0; max-height: 100%;
  background: var(--bg-primary); color: var(--text-primary);
  margin: 0; padding: 0; border: 1px solid var(--border-color); border-radius: 16px;
  box-shadow: 0 18px 54px var(--card-shadow-hover); overflow: hidden;
  font-family: Archivo, system-ui, sans-serif;
}
#crotts-panel :is(button, a, textarea):focus-visible, #crotts-thread:focus-visible {
  outline: 2px solid var(--secondary-text); outline-offset: -3px;
}
#crotts-head {
  display: flex; align-items: center; gap: .7rem; padding: .65rem .8rem;
  background: var(--member-chrome-bg); color: var(--member-chrome-ink);
}
#crotts-head img {
  flex: 0 0 42px; width: 42px; height: 42px; border-radius: 50%;
  object-fit: cover; object-position: center 28%; border: 1px solid var(--member-chrome-line);
}
#crotts-head h2 { margin: 0; color: inherit; font-size: 1.15rem; font-weight: 775; line-height: 1.12; }
#crotts-head p { margin: .12rem 0 0; color: inherit; font-size: .78rem; line-height: 1.23; }
#crotts-panel button, .crotts-action {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  min-height: 44px; min-width: 44px; border-radius: 9px;
  font: 680 .84rem/1.25 Archivo, system-ui, sans-serif; cursor: pointer;
}
#crotts-close {
  flex: 0 0 44px; margin-inline-start: auto;
  border: 1px solid var(--member-chrome-line); background: transparent; color: inherit;
}
#crotts-close:hover { background: var(--member-chrome-hover); }
#crotts-close:focus-visible { outline-color: var(--member-chrome-focus); }
#crotts-thread {
  min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: .85rem; background: var(--bg-secondary);
}
#crotts-msgs { display: flex; flex-direction: column; gap: .5rem; }
.crotts-b {
  box-sizing: border-box; max-width: 92%; padding: .65rem .78rem;
  border-radius: 13px; font-size: .92rem; line-height: 1.46;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.crotts-b.them {
  align-self: flex-start; border: 1px solid var(--border-color); border-end-start-radius: 4px;
  background: var(--bg-primary); color: var(--text-primary);
}
.crotts-b.me {
  align-self: flex-end; border-end-end-radius: 4px;
  background: var(--member-chrome-bg); color: var(--member-chrome-ink);
}
.crotts-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .55rem; }
.crotts-action {
  max-width: 100%; padding: .35rem .62rem; border: 1px solid var(--border-color);
  background: var(--bg-secondary); color: var(--text-primary); text-decoration: none;
}
.crotts-action:hover { border-color: var(--secondary-text); text-decoration: underline; }
.crotts-composer { border-top: 1px solid var(--border-color); }
#crotts-form { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: .35rem; padding: .55rem; }
#crotts-input {
  box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px;
  resize: none; padding: .6rem .5rem; border: 1px solid var(--border-color); border-radius: 9px;
  font: inherit; font-size: max(16px, .86rem); line-height: 1.24;
  background: var(--bg-secondary); color: var(--text-primary);
}
#crotts-attach, .crotts-shot button {
  border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary);
}
#crotts-attach:hover:not(:disabled), .crotts-shot button:hover { border-color: var(--secondary-text); }
#crotts-send {
  gap: .34rem; padding: .34rem .62rem; border: 1px solid transparent;
  background: var(--member-chrome-bg); color: var(--member-chrome-ink);
}
#crotts-send:hover:not(:disabled) { background: var(--member-chrome-hover); }
#crotts-panel button:disabled { opacity: .58; cursor: default; }
#crotts-file { display: none; }
.crotts-shot {
  display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center;
  gap: .5rem; padding: .5rem .55rem 0; font-size: .82rem; line-height: 1.25;
}
.crotts-shot img { width: 42px; height: 42px; object-fit: cover; border-radius: 7px; border: 1px solid var(--border-color); }
.crotts-shot button { padding: 0 .55rem; }
.crotts-status { margin-top: .45rem; font-size: .86rem; line-height: 1.35; color: var(--text-secondary); }
.crotts-status.error {
  padding: .6rem .7rem; border: 1px solid var(--over); border-radius: 9px;
  background: var(--over-soft); color: var(--text-primary);
}
@media (max-width: 600px) {
  .crotts-overlay { align-items: end; padding-inline: .45rem; padding-bottom: max(.45rem, var(--safe-bottom)); }
}
.crotts-overlay.crotts-keyboard {
  align-items: stretch; padding-top: .4rem; padding-bottom: .4rem;
}
.crotts-overlay.crotts-keyboard > #crotts-panel {
  width: min(100%, 28rem); height: 100%; max-height: 100%; min-height: 0;
}
.crotts-overlay.crotts-keyboard-guess { align-items: start; padding-top: max(.4rem, var(--safe-top)); }
.crotts-overlay.crotts-keyboard-guess > #crotts-panel { max-height: 46vh; max-height: 46dvh; min-height: 0; }
@media (max-width: 360px) { #crotts-send svg { display: none; } }
`;

/** Covered strip when the keyboard overlays the layout instead of resizing it. */
export function visibleKeyboardInset(innerHeight, offsetTop, viewportHeight) {
  const inner = Number(innerHeight);
  const top = Number(offsetTop);
  const height = Number(viewportHeight);
  if (!Number.isFinite(inner) || !Number.isFinite(top) || !Number.isFinite(height)) return { top: 0, bottom: 0 };
  return {
    top: Math.max(0, Math.round(top)),
    bottom: Math.max(0, Math.round(inner - top - height)),
  };
}

/** Larger of the two keyboard measurements: the visual viewport (iOS, default Android) and the
 *  VirtualKeyboard API (Android Chrome with interactive-widget=overlays-content, where the visual viewport
 *  does not shrink). */
export function keyboardBox(viewportInset, virtualKeyboardHeight) {
  const vk = Math.max(0, Math.round(Number(virtualKeyboardHeight) || 0));
  return { top: viewportInset.top, bottom: Math.max(viewportInset.bottom, vk) };
}

function useKeyboardViewport(open, threadRef) {
  const [box, setBox] = React.useState({ top: 0, bottom: 0, guess: false });
  React.useEffect(() => {
    if (!open) return undefined;
    const viewport = window.visualViewport;
    // Our pages declare interactive-widget=overlays-content, so on Android the keyboard covers the page
    // without shrinking the visual viewport. Opt in to the VirtualKeyboard API while Crotts is open so the
    // browser reports the keyboard's height (same overlay behaviour, plus geometry), then restore it.
    const vk = navigator.virtualKeyboard;
    const previousOverlay = vk ? vk.overlaysContent : null;
    if (vk) { try { vk.overlaysContent = true; } catch { /* unsupported */ } }
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    let frame = 0;
    let focused = false;
    let guess = false;
    const timers = [];
    const apply = () => {
      const inset = viewport
        ? visibleKeyboardInset(window.innerHeight, viewport.offsetTop, viewport.height)
        : { top: 0, bottom: 0 };
      const measured = keyboardBox(inset, vk?.boundingRect?.height);
      const next = { ...measured, guess: guess && measured.bottom <= 72 };
      setBox((current) => current.top === next.top && current.bottom === next.bottom && current.guess === next.guess ? current : next);
      const thread = threadRef.current;
      if ((next.bottom > 72 || next.guess) && thread) thread.scrollTop = thread.scrollHeight;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    const burst = () => {
      schedule();
      timers.push(window.setTimeout(schedule, 60), window.setTimeout(schedule, 280));
    };
    const onFocus = (event) => {
      if (event.target?.id !== "crotts-input") return;
      focused = true;
      burst();
      // Last resort for browsers that report no keyboard geometry at all: on a touch screen, once the field
      // has focus and nothing has been measured, lift the panel into the top half where a keyboard can't reach.
      if (coarse && !vk) {
        timers.push(window.setTimeout(() => {
          if (focused) { guess = true; schedule(); }
        }, 450));
      }
    };
    const onBlur = (event) => {
      if (event.target?.id !== "crotts-input") return;
      focused = false;
      guess = false;
      timers.push(window.setTimeout(schedule, 120));
    };
    apply();
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    vk?.addEventListener?.("geometrychange", schedule);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      vk?.removeEventListener?.("geometrychange", schedule);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      if (vk) { try { vk.overlaysContent = previousOverlay; } catch { /* unsupported */ } }
    };
  }, [open, threadRef]);
  return box;
}

function apiBase() {
  return resolveApiBase({ datasetKeys: ["apiBase", "authBase"] });
}

function icon(Icon, size = 18, key) {
  return h(Icon, {
    "aria-hidden": "true",
    focusable: "false",
    key,
    size,
    strokeWidth: 2.3,
  });
}

function messageId(counter) {
  counter.current += 1;
  return `crotts-${counter.current}`;
}

function isHelpHash() {
  return String(window.location.hash || "").toLowerCase() === "#help";
}

function clearHelpHash() {
  if (!isHelpHash()) return;
  const path = window.location.pathname + window.location.search;
  try {
    window.history.replaceState(null, "", path);
  } catch {
  }
}

export function requestCrottsHelp(returnFocus) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CROTTS_HELP_EVENT, { detail: { returnFocus } }));
}

export function CrottsHelpLink(props) {
  return h("a", {
    "aria-haspopup": "dialog",
    className: props.className,
    href: "#help",
    onClick: (event) => {
      event.preventDefault();
      const link = event.currentTarget;
      requestCrottsHelp(() => props.returnFocus ? props.returnFocus(link) : link);
      props.onClick?.(event);
    },
  }, props.children ?? "Help");
}

function AssistantBubble({ message }) {
  const actions = sanitizeCrottsActions(message.actions);
  return h("div", { className: `crotts-b ${message.kind}` }, [
    message.content,
    actions.length
      ? h("div", { className: "crotts-actions", key: "actions" }, actions.map((action) => h("a", {
        className: "crotts-action",
        href: action.href,
        key: action.href,
      }, action.label)))
      : null,
  ]);
}

export function CrottsWidget() {
  const [open, setOpen] = React.useState(false);
  const [operation, setOperation] = React.useState(null);
  const [error, setError] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [shot, setShot] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const historyRef = React.useRef([]);
  const operationRef = React.useRef(null);
  const restoreFocus = React.useRef(null);
  const inputRef = React.useRef(null);
  const fileRef = React.useRef(null);
  const attachRef = React.useRef(null);
  const threadRef = React.useRef(null);
  const idCounter = React.useRef(0);
  const api = React.useMemo(apiBase, []);
  const titleId = React.useId();
  const busy = operation != null;
  const dialog = useAccessibleDialog({ open, onClose: closeHelp, labelledBy: titleId,
    label: "Crotts assistant", returnFocus: () => restoreFocus.current?.() });
  const keyboard = useKeyboardViewport(open, threadRef);

  React.useEffect(() => {
    function openHelp(event) {
      if (dialog.panelRef.current) return;
      const restore = event?.detail?.returnFocus;
      restoreFocus.current = typeof restore === "function" ? restore : null;
      setOpen(true);
    }
    function openHelpFromHash() {
      if (isHelpHash()) openHelp();
    }
    window.addEventListener(CROTTS_HELP_EVENT, openHelp);
    window.addEventListener("hashchange", openHelpFromHash);
    if (isHelpHash()) openHelp();
    return () => {
      window.removeEventListener(CROTTS_HELP_EVENT, openHelp);
      window.removeEventListener("hashchange", openHelpFromHash);
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setMessages((current) => {
      if (current.length) return current;
      return [{
        content: "Ask me about club events, courses, scoring, or rules questions. Share a photo or short video of a lie for help with a ruling. I can also open the page you need.",
        id: messageId(idCounter),
        kind: "them",
      }];
    });
  }, [open]);

  React.useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, busy, error]);

  function closeHelp() {
    setOpen(false);
    clearHelpHash();
  }

  function updateOperation(next) {
    operationRef.current = next;
    setOperation(next);
  }

  async function onPickFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || operationRef.current) return;
    inputRef.current?.focus({ preventScroll: true });
    updateOperation("attachment");
    setError("");
    try {
      const video = file.type.startsWith("video/");
      const images = video ? await videoFrames(file) : [await photoDataUrl(file)].filter(Boolean);
      if (!images.length) {
        setError(video ? "No frames were found in this video. Try a photo of the lie." : "Couldn’t read that photo. Try another one.");
        return;
      }
      setShot({
        images,
        kind: video ? "video" : "photo",
        label: video ? "Video frame" + (images.length > 1 ? "s" : "") + " attached" : "Photo attached",
        preview: images[0],
      });
    } catch {
      setError("Couldn’t read that file. Try a photo of the lie.");
    } finally {
      updateOperation(null);
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    const attachment = shot;
    if ((!text && !attachment) || operationRef.current) return;

    inputRef.current?.focus({ preventScroll: true });
    updateOperation("send");
    setError("");
    const shown = [text, attachment?.label].filter(Boolean).join("\n");
    try {
      const payload = { message: text, history: historyRef.current.slice(-8) };
      if (attachment) {
        payload.images = attachment.images;
        payload.mediaKind = attachment.kind;
      }
      const response = await fetch(`${api}/assistant`, {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setError(response.status === 429 ? "Crotts is getting a lot of questions. Try again in a minute." : "Crotts couldn’t answer. Try sending your question again.");
        return;
      }
      const data = await response.json();
      const reply = data?.reply ? String(data.reply) : "Hmm, I didn't catch that.";
      const actions = sanitizeCrottsActions(data?.actions);
      setMessages((current) => current.concat(
        { content: shown, id: messageId(idCounter), kind: "me" },
        { actions, content: reply, id: messageId(idCounter), kind: "them" },
      ));
      setDraft("");
      setShot(null);
      historyRef.current = historyRef.current.concat(
        { role: "user", content: shown },
        { role: "assistant", content: reply },
      ).slice(-16);
    } catch {
      setError("Couldn’t connect to Crotts. Check your connection and try again.");
    } finally {
      updateOperation(null);
    }
  }

  if (!open) return null;

  return createPortal(h("div", {
    "data-a11y-overlay": "true",
    className: "crotts-overlay" + (keyboard.bottom > 72 ? " crotts-keyboard" : keyboard.guess ? " crotts-keyboard-guess" : ""),
    ref: dialog.overlayRef,
    role: "presentation",
    style: { "--crotts-vv-top": keyboard.top + "px", "--crotts-keyboard": keyboard.bottom + "px" },
  }, [
    h("style", { key: "style" }, CROTTS_CSS),
    h("div", {
      "aria-labelledby": titleId,
      "aria-modal": dialog.isolated ? "true" : undefined,
      id: "crotts-panel",
      key: "panel",
      ref: dialog.panelRef,
      role: "dialog",
      tabIndex: -1,
    }, [
      h("div", { id: "crotts-head", key: "head" }, [
        h("img", { alt: "", key: "avatar", src: AVATAR }),
        h("div", { key: "titles" }, [
          h("h2", { "aria-label": "Crotts assistant", id: titleId, key: "title" }, "Crotts"),
          h("p", { key: "subtitle" }, "Club assistant"),
        ]),
        h("button", {
          "aria-label": "Close Crotts assistant",
          id: "crotts-close",
          key: "close",
          onClick: closeHelp,
          type: "button",
        }, icon(X, 20)),
      ]),
      h("div", { "aria-label": "Conversation", id: "crotts-thread", key: "thread", ref: threadRef, role: "region", tabIndex: 0 }, [
        h("div", { "aria-label": "Messages", id: "crotts-msgs", key: "messages", role: "log" },
          messages.map((message) => h(AssistantBubble, { key: message.id, message }))),
        busy && h("div", { className: "crotts-status", key: "progress", role: "status" }, operation === "attachment"
          ? "Preparing attachment…" : shot ? "Crotts is looking at your attachment…" : "Waiting for Crotts…"),
        error && h("div", { className: "crotts-status error", key: "error", role: "alert" }, error),
      ]),
      h("div", { className: "crotts-composer", key: "composer" }, [
        shot && h("div", { className: "crotts-shot", key: "shot" }, [
          h("img", { alt: "", key: "preview", src: shot.preview }),
          h("span", { key: "label", role: "status" }, shot.label),
          h("button", { "aria-label": "Remove attachment", disabled: busy, key: "clear", onClick: () => {
            attachRef.current?.focus({ preventScroll: true });
            setShot(null);
          }, type: "button" }, "Remove"),
        ]),
        h("form", {
          id: "crotts-form",
          key: "form",
          onSubmit: (event) => {
            event.preventDefault();
            void sendMessage();
          },
        }, [
          h("input", {
            accept: "image/*,video/*",
            id: "crotts-file",
            key: "file",
            onChange: (event) => { void onPickFile(event); },
            ref: fileRef,
            type: "file",
          }),
          h("button", {
            "aria-label": "Attach a photo or video of the lie",
            disabled: busy,
            id: "crotts-attach",
            key: "attach",
            onClick: () => fileRef.current?.click(),
            ref: attachRef,
            type: "button",
          }, icon(ImagePlus)),
          h("textarea", {
            "aria-label": "Message Crotts",
            id: "crotts-input",
            key: "input",
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void sendMessage();
              }
            },
            placeholder: shot ? "Ask about the lie" : "Ask Crotts",
            readOnly: busy,
            ref: inputRef,
            rows: 1,
            value: draft,
          }),
          h("button", {
            disabled: busy || (!draft.trim() && !shot),
            id: "crotts-send",
            key: "send",
            type: "submit",
          }, [
            icon(Send, 15, "icon"),
            h("span", { key: "label" }, operation === "send" ? "Sending" : "Send"),
          ]),
        ]),
      ]),
    ]),
  ]), document.body);
}
