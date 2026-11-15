import { spectatorHeaders, watchKeyFromLocation } from "../shared/spectator-link.js";
import React from "react";
import { createPortal } from "react-dom";
import { MessageCircle } from "lucide-react";

import { resolveApiBase } from "../shared/api-base.js";
import { liveRoundCodeFromSearch } from "../shared/live-watch.js";
import { readMemberToken } from "../shared/member-session.js";
import { readOpenPlayToken } from "./open-play-session.js";
import { ROUND_MESSAGE_MAX, mergeRoundMessages, messageSortId, normalizeRoundMessage, roundMessageNotice, unseenRoundMessages } from "../shared/round-messages-model.js";

const h = React.createElement;
const NAME_KEY = "gvdg_chat_name";
const POLL_MS = 2000;
const TALK_TAG = "gvdg-card-talk";

function seenKey(path) { return "gvdg.roundTalkSeen:" + path; }
function notifiedKey(path) { return "gvdg.roundTalkNotified:" + path; }

function readStoredId(key) {
  try {
    const id = Number(localStorage.getItem(key));
    return Number.isFinite(id) ? id : 0;
  } catch {
    return 0;
  }
}

function writeStoredId(key, id) {
  try { localStorage.setItem(key, String(id)); } catch { /* private mode */ }
}

export async function postCardMessageNotice(note, pageUrl) {
  if (!note || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg || typeof reg.showNotification !== "function") return;
  const origin = (typeof location !== "undefined" && location.origin) || "";
  await reg.showNotification(note.title, {
    body: note.body,
    tag: TALK_TAG,
    renotify: true,
    icon: origin + "/img/icons/app-icon-192.png",
    badge: origin + "/img/icons/notification-badge.png",
    data: { kind: "talk", url: pageUrl || "/score.html" },
  });
}

export async function closeCardMessageNotice() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg || typeof reg.getNotifications !== "function") return;
  const notes = await reg.getNotifications({ tag: TALK_TAG });
  for (const note of notes) note.close();
}

function scoreTalkUrl() {
  if (typeof location === "undefined") return "/score.html";
  const path = String(location.pathname || "");
  const search = String(location.search || "");
  const url = (path.startsWith("/") ? path : "/" + path) + search;
  return url.startsWith("/score.html") && !url.includes("://") ? url : "/score.html";
}

export function messagePathFromLocation(loc) {
  const params = new URLSearchParams((loc && loc.search) || "");
  if (watchKeyFromLocation(loc || {})) return "/watch-round/messages";
  const code = liveRoundCodeFromSearch(params);
  const eventId = String(params.get("event") || "").replace(/[^0-9]/g, "");
  if (code) return "/rounds/" + code + "/live/messages";
  if (eventId) return "/events/" + eventId + "/live/messages";
  return "";
}

function storedName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}

function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
}

function authHeaders() {
  const token = readMemberToken() || readOpenPlayToken() || "";
  return token ? { Authorization: "Bearer " + token } : {};
}

function withGuest(path) {
  if (readMemberToken() || readOpenPlayToken()) return path;
  let gt = "";
  try { gt = new URLSearchParams(window.location.search).get("gt") || ""; } catch { gt = ""; }
  if (!gt) return path;
  return path + (path.includes("?") ? "&" : "?") + "gt=" + encodeURIComponent(gt);
}

function sendError(status) {
  if (status === 409) return "Messages close when the round is over.";
  if (status === 429) return "Easy. Give it a second.";
  if (status === 413) return "Keep it under 280 characters.";
  if (status === 400) return "Need a name and a message.";
  return "Couldn't send that.";
}

function useAboveDock(active) {
  const [bottom, setBottom] = React.useState("0.75rem");
  React.useEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    const dock = document.querySelector(".score-glove-dock");
    function place() {
      if (!dock) {
        setBottom("0.75rem");
        return;
      }
      const gap = window.innerHeight - dock.getBoundingClientRect().top + 8;
      setBottom(Math.max(8, Math.round(gap)) + "px");
    }
    place();
    window.addEventListener("resize", place);
    const observer = dock && typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (observer) observer.observe(dock);
    return () => {
      window.removeEventListener("resize", place);
      if (observer) observer.disconnect();
    };
  }, [active]);
  return bottom;
}

function TalkRow({ message }) {
  const who = message.side === "card" ? "On the card" : "Watching";
  const aimed = message.toName ? " to " + message.toName : "";
  return h("div", { className: "round-talk-row " + message.side }, [
    h("div", { className: "round-talk-meta", key: "meta" }, [
      h("span", { key: "who" }, message.authorName + aimed),
      h("span", { className: "round-talk-side", key: "side" }, who),
    ]),
    h("p", { className: "round-talk-body", key: "body" }, message.body),
  ]);
}

export function RoundTalk({ inline, live, players, viewer, viewerName }) {
  const path = React.useMemo(() => messagePathFromLocation(window.location), []);
  const key = viewer === "watch" ? watchKeyFromLocation(window.location) : null;
  const api = React.useMemo(() => resolveApiBase({ datasetKeys: ["apiBase"] }), []);
  const [open, setOpen] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [messages, setMessages] = React.useState([]);
  const [draft, setDraft] = React.useState("");
  const [name, setName] = React.useState(() => viewerName || storedName());
  const [toName, setToName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [seen, setSeen] = React.useState(() => readStoredId(seenKey(path)));
  const [toast, setToast] = React.useState(null);
  const listRef = React.useRef(null);
  const notifiedRef = React.useRef(readStoredId(notifiedKey(path)));
  const seenRef = React.useRef(seen);
  const latestUnseenRef = React.useRef(null);
  const names = [...new Set((Array.isArray(players) ? players : []).map((player) => String(player || "").trim()).filter(Boolean))];
  const unseen = unseenRoundMessages(messages, seen, viewer);
  const latestUnseen = unseen.length ? unseen[unseen.length - 1] : null;
  const latestUnseenId = latestUnseen ? messageSortId(latestUnseen) : 0;
  latestUnseenRef.current = latestUnseen;

  function markSeen(rows) {
    const last = (Array.isArray(rows) ? rows : []).reduce((max, message) => Math.max(max, messageSortId(message)), 0);
    if (last > seenRef.current) {
      seenRef.current = last;
      setSeen(last);
      writeStoredId(seenKey(path), last);
    }
    if (last > notifiedRef.current) {
      notifiedRef.current = last;
      writeStoredId(notifiedKey(path), last);
    }
    setToast(null);
    void closeCardMessageNotice();
  }

  React.useEffect(() => {
    if (viewerName) setName(viewerName);
  }, [viewerName]);

  const reload = React.useCallback((signal) => {
    if (!path || !live) return Promise.resolve();
    return fetch(api + (key ? path : withGuest(path)), { cache: "no-store", headers: { Accept: "application/json", ...(key ? spectatorHeaders(key) : authHeaders()) }, signal })
      .then((response) => (response.ok ? response.json() : { open: false, messages: [] }))
      .then((data) => {
        setChatOpen(data?.open === true);
        const next = (Array.isArray(data?.messages) ? data.messages : []).map(normalizeRoundMessage).filter(Boolean);
        setMessages((current) => mergeRoundMessages(current, next));
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
      });
  }, [api, key, live, path]);

  React.useEffect(() => {
    if (!path || !live) return undefined;
    const ac = new AbortController();
    void reload(ac.signal);
    const timer = window.setInterval(() => { void reload(ac.signal); }, POLL_MS);
    function onShow() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") void reload(ac.signal);
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onShow);
    return () => {
      ac.abort();
      window.clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onShow);
    };
  }, [live, path, reload]);

  React.useEffect(() => {
    if (!open) return;
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    markSeen(messages);
  }, [open, messages]);

  React.useEffect(() => {
    if (open || latestUnseenId <= notifiedRef.current) return undefined;
    const message = latestUnseenRef.current;
    if (!message) return undefined;
    notifiedRef.current = latestUnseenId;
    writeStoredId(notifiedKey(path), latestUnseenId);
    setToast(message);
    if (typeof document !== "undefined" && document.hidden) {
      void postCardMessageNotice(roundMessageNotice(message), scoreTalkUrl()).catch(() => {});
    }
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [latestUnseenId, open, path]);

  const lift = Boolean(inline && (open || toast));
  const aboveDock = useAboveDock(lift);

  if (!path || !live) return null;
  const unread = open ? 0 : unseen.length;
  const showName = viewer !== "card" && !viewerName;

  async function send(event) {
    event.preventDefault();
    const text = draft.trim();
    const who = (viewerName || name).trim();
    if (!text || !who || busy || key) return;
    setBusy(true);
    setNote("");
    rememberName(who);
    try {
      const response = await fetch(api + withGuest(path), {
        body: JSON.stringify({ body: text, name: who, toName: viewer === "watch" ? toName : "" }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNote(sendError(response.status));
        return;
      }
      const message = normalizeRoundMessage(data.message);
      if (message) setMessages((current) => mergeRoundMessages(current, [message]));
      setDraft("");
      setChatOpen(true);
    } catch {
      setNote("Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  const sheetStyle = inline ? { bottom: aboveDock } : undefined;
  const toastNode = toast && !open ? h("button", {
    className: "round-talk-toast" + (inline ? " round-talk-sheet" : ""),
    key: "toast",
    onClick: () => setOpen(true),
    style: sheetStyle,
    type: "button",
  }, [
    h("strong", { key: "who" }, toast.authorName),
    h("span", { key: "body" }, toast.body),
  ]) : null;
  const panelNode = open ? h("div", {
    className: "round-talk-panel" + (inline ? " round-talk-sheet" : ""),
    key: "panel",
    style: sheetStyle,
  }, [
    h("div", { className: "round-talk-list", key: "list", ref: listRef }, messages.length
      ? messages.map((message) => h(TalkRow, { key: message.id || message.body, message }))
      : h("p", { className: "muted", key: "empty" }, chatOpen ? "No messages yet." : "Messages open while the round is live.")),
    key ? null : h("form", { className: "round-talk-form", key: "form", onSubmit: (event) => { void send(event); } }, [
      viewer === "watch" && names.length ? h("select", {
        "aria-label": "Who is this for",
        key: "to",
        onChange: (event) => setToName(event.target.value),
        value: toName,
      }, [
        h("option", { key: "card", value: "" }, "The card"),
        ...names.map((player) => h("option", { key: player, value: player }, player)),
      ]) : null,
      showName ? h("input", {
        "aria-label": "Your name",
        key: "name",
        maxLength: 32,
        onChange: (event) => setName(event.target.value),
        placeholder: "Your name",
        value: name,
      }) : null,
      h("input", {
        "aria-label": "Message",
        key: "draft",
        maxLength: ROUND_MESSAGE_MAX,
        onChange: (event) => setDraft(event.target.value),
        placeholder: viewer === "card" ? "Reply" : "Say something",
        value: draft,
      }),
      h("button", { className: "btn primary", disabled: busy, key: "send", type: "submit" }, busy ? "Sending" : "Send"),
    ]),
    note ? h("p", { className: "round-talk-note", key: "note", role: "alert" }, note) : null,
  ]) : null;

  return h("section", { className: "round-talk" + (open ? " open" : "") + (inline ? " is-inline" : ""), "data-react-round-talk": open ? "open" : "closed" }, [
    inline ? null : toastNode,
    h("button", {
      "aria-expanded": open ? "true" : "false",
      "aria-label": unread ? `Messages, ${unread} new` : "Messages",
      className: (inline ? "score-glove-tool " : "") + "round-talk-bubble" + (unread ? " has-new" : ""),
      key: "toggle",
      onClick: () => setOpen((current) => !current),
      type: "button",
    }, [
      h(MessageCircle, { "aria-hidden": "true", focusable: "false", key: "icon", size: inline ? 18 : 22, strokeWidth: 2.4 }),
      inline ? h("span", { key: "label" }, "Messages") : null,
      unread ? h("span", { className: "round-talk-badge", key: "badge" }, unread > 9 ? "9+" : String(unread)) : null,
    ]),
    inline ? null : panelNode,
    inline && typeof document !== "undefined" ? createPortal(h(React.Fragment, { key: "sheet" }, [toastNode, panelNode]), document.body) : null,
  ]);
}
