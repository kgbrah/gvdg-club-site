import React from "react";

import { formatClubDateTime } from "../shared/events-model.js";
import {
  EVENT_CHAT_BODY_MAX,
  EVENT_CHAT_NAME_MAX,
  mergeChatMessages,
  normalizeChatMessage,
} from "../shared/event-chat-model.js";

const h = React.createElement;
const NAME_KEY = "gvdg_chat_name";
const POLL_MS = 4000;

function storageGet(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function postErrorMessage(status) {
  if (status === 409) return "Chat opens when this event goes live.";
  if (status === 429) return "Easy, champ. Give it a second.";
  if (status === 413) return "Keep it under 280 characters.";
  if (status === 400) return "Need a name and a message.";
  return "Couldn't send that.";
}

function ChatRow({ message }) {
  return h("div", { className: "live-chat-row" }, [
    h("div", { className: "live-chat-meta", key: "meta" }, [
      h("span", { className: "live-chat-author", key: "name" }, message.authorName),
      message.createdAt ? h("span", { className: "live-chat-when", key: "when" }, formatClubDateTime(message.createdAt) || message.createdAt) : null,
    ]),
    h("div", { className: "live-chat-body", key: "body" }, message.body),
  ]);
}

export function EventLiveChat({ apiBase, eventId, memberName, memberToken }) {
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState([]);
  const [name, setName] = React.useState(() => memberName || storageGet(NAME_KEY));
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const scroller = React.useRef(null);
  const signedIn = Boolean(memberToken && memberName);

  const reload = React.useCallback((signal) => {
    if (!apiBase || eventId == null) return Promise.resolve();
    return fetch(`${apiBase}/events/${encodeURIComponent(eventId)}/chat`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    })
      .then((response) => (response.ok ? response.json() : { open: false, messages: [] }))
      .then((data) => {
        setOpen(data?.open === true);
        const next = (Array.isArray(data?.messages) ? data.messages : []).map(normalizeChatMessage).filter(Boolean);
        setMessages((current) => mergeChatMessages(current, next));
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
      });
  }, [apiBase, eventId]);

  React.useEffect(() => {
    const ac = new AbortController();
    reload(ac.signal);
    const timer = window.setInterval(() => reload(ac.signal), POLL_MS);
    return () => {
      ac.abort();
      window.clearInterval(timer);
    };
  }, [reload]);

  React.useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  async function onSubmit(event) {
    event.preventDefault();
    const text = draft.trim();
    const author = (signedIn ? memberName : name).trim();
    if (!text || !author) {
      setStatus("Need a name and a message.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      if (memberToken) headers.Authorization = `Bearer ${memberToken}`;
      const response = await fetch(`${apiBase}/events/${encodeURIComponent(eventId)}/chat`, {
        body: JSON.stringify({ body: text, name: author }),
        headers,
        method: "POST",
      });
      if (!response.ok) {
        setStatus(postErrorMessage(response.status));
        return;
      }
      const payload = await response.json();
      const created = normalizeChatMessage(payload?.message);
      if (!signedIn) storageSet(NAME_KEY, author);
      setDraft("");
      if (created) setMessages((current) => mergeChatMessages(current, [created]));
    } catch (error) {
      if (error?.name === "AbortError") return;
      setStatus("Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return h("section", { className: "live-chat", "data-react-live-chat": "ready" }, [
    h("div", { className: "live-chat-head", key: "head" }, [
      h("h3", { className: "live-chat-title", key: "title" }, "Live chat"),
      h("p", { className: "live-chat-note", key: "note" }, "Cheer loud. Talk trash. Don't be a jerk to juniors."),
    ]),
    h("div", { className: "live-chat-list", key: "list", ref: scroller },
      messages.length
        ? messages.map((message) => h(ChatRow, { key: message.id || message.createdAt + message.body, message }))
        : h("p", { className: "live-chat-empty" }, "Be the first to chirp. Parked it? Let 'em hear it."),
    ),
    h("form", { className: "live-chat-form", key: "form", onSubmit }, [
      signedIn
        ? h("div", { className: "live-chat-as", key: "as" }, "Posting as " + memberName)
        : h("input", {
          className: "live-chat-input",
          key: "name",
          maxLength: EVENT_CHAT_NAME_MAX,
          onChange: (event) => setName(event.target.value),
          placeholder: "Your name",
          value: name,
        }),
      h("textarea", {
        className: "live-chat-input live-chat-draft",
        key: "draft",
        maxLength: EVENT_CHAT_BODY_MAX,
        onChange: (event) => setDraft(event.target.value),
        placeholder: "Nice birdie. Or don't.",
        rows: 2,
        value: draft,
      }),
      h("button", { className: "live-chat-send", disabled: busy, key: "send", type: "submit" }, busy ? "Sending..." : "Send"),
      status ? h("div", { className: "live-chat-status", key: "status" }, status) : null,
    ]),
  ]);
}
