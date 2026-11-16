import React from "react";
import { ChevronLeft, Mail, Search } from "lucide-react";

import { requestJson } from "./api.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { plural } from "./format.js";
import { announceInboxChanged, useInboxSummary } from "./inbox-summary.js";
import { useSessionToken } from "./session-token.js";

const h = React.createElement;

function threadFromHash() {
  const hash = String(window.location.hash || "");
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const id = new URLSearchParams(query).get("thread");
  return /^\d{1,12}$/.test(id || "") ? id : null;
}

function messageWhen(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const stamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}/.test(raw)
    ? raw.replace(" ", "T") + "Z"
    : raw;
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return "";
  const zone = "America/New_York";
  const sameDay = date.toLocaleDateString("en-US", { timeZone: zone }) === new Date().toLocaleDateString("en-US", { timeZone: zone });
  return date.toLocaleString("en-US", sameDay
    ? { hour: "numeric", minute: "2-digit", timeZone: zone }
    : { month: "short", day: "numeric", timeZone: zone });
}

function memberDestination(href) {
  if (typeof href !== "string" || !href.startsWith("/gvdg-members.html#")) return null;
  if (href.includes("\\") || href.includes("://")) return null;
  const [tab, query = ""] = href.slice("/gvdg-members.html#".length).split("?");
  if (!/^[a-z0-9-]{1,40}$/.test(tab || "")) return null;
  return { tab, thread: new URLSearchParams(query).get("thread") };
}

function setMessagesHash(id, replace) {
  const next = id ? "#messages?thread=" + id : "#messages";
  if (window.location.hash === next) return;
  const url = window.location.pathname + window.location.search + next;
  if (replace) window.history.replaceState(null, "", url);
  else window.location.hash = next;
}

export function InboxHomeAlert() {
  const token = useSessionToken();
  const inbox = useInboxSummary(token);
  if (!inbox.total) return null;
  const parts = [];
  if (inbox.unread) parts.push(`${inbox.unread} ${plural(inbox.unread, "new message", "new messages")}`);
  if (inbox.unseen) parts.push(`${inbox.unseen} ${plural(inbox.unseen, "club update", "club updates")}`);
  return h("button", {
    type: "button",
    className: "member-inbox-alert",
    onClick: () => selectDashboardTab("messages"),
  }, [
    h(Mail, { size: 20, "aria-hidden": true, key: "icon" }),
    h("span", { className: "member-inbox-alert-copy", key: "copy" }, [
      h("strong", { key: "title" }, "You have something new"),
      h("small", { key: "detail" }, parts.join(" · ")),
    ]),
  ]);
}

function PeopleSearch({ token, onPick }) {
  const [query, setQuery] = React.useState("");
  const [people, setPeople] = React.useState([]);
  const [status, setStatus] = React.useState("loading");

  React.useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      requestJson("/me/messages/people?q=" + encodeURIComponent(query.trim()), { token, signal: controller.signal })
        .then((data) => {
          setPeople(Array.isArray(data?.people) ? data.people : []);
          setStatus("ready");
        })
        .catch((error) => {
          if (error?.name === "AbortError") return;
          setStatus("error");
        });
    }, 160);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, token]);

  return h("div", { className: "member-people-search" }, [
    h("label", { className: "member-people-search-field", key: "field" }, [
      h(Search, { size: 16, "aria-hidden": true, key: "icon" }),
      h("input", {
        key: "input",
        type: "search",
        value: query,
        maxLength: 40,
        placeholder: "Member name",
        "aria-label": "Find a member",
        autoComplete: "off",
        onChange: (event) => setQuery(event.target.value),
      }),
    ]),
    status === "error" ? h("p", { className: "player-card-meta", role: "status", key: "error" }, "Could not load members.") : null,
    people.length ? h("div", { className: "member-list-rows", role: "list", key: "list" }, people.map((person) => h("button", {
      type: "button",
      className: "member-list-row",
      role: "listitem",
      key: person.memberId,
      onClick: () => onPick(person),
    }, h("span", { className: "member-list-copy" }, h("span", { className: "member-list-name" }, person.name || "Member"))))) : null,
    status === "ready" && !people.length ? h("p", { className: "player-card-meta", key: "empty" }, query.trim() ? "No member matches that name." : "No other members to message yet.") : null,
  ]);
}

function Composer({ label, value, busy, error, onChange, onSubmit }) {
  return h("form", { className: "member-composer", onSubmit }, [
    h("textarea", {
      key: "input",
      rows: 2,
      maxLength: 500,
      value,
      "aria-label": label,
      placeholder: "Write a message",
      onChange: (event) => onChange(event.target.value),
    }),
    h("button", { className: "player-btn primary", type: "submit", disabled: busy || !value.trim(), key: "send" }, busy ? "Sending…" : "Send"),
    error ? h("p", { className: "player-card-meta member-composer-error", role: "status", key: "error" }, error) : null,
  ]);
}

function sendError(error) {
  return error?.status === 429 ? "That's a lot of messages. Wait a little, then try again." : "Could not send that.";
}

function DraftView({ token, person, onBack, onSent }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await requestJson("/me/messages", { token, method: "POST", body: { to: person.memberId, body } });
      announceInboxChanged();
      onSent(String(saved.threadId));
    } catch (caught) {
      setError(sendError(caught));
      setBusy(false);
    }
  }

  return h("section", { className: "member-inbox member-thread", "aria-label": "New message" }, [
    h("button", { type: "button", className: "member-parent-link", onClick: onBack, key: "back" }, [
      h(ChevronLeft, { size: 16, "aria-hidden": true, key: "icon" }),
      "Inbox",
    ]),
    h("h2", { key: "who" }, person.name || "Member"),
    h(Composer, { label: "Message", value: text, busy, error, onChange: setText, onSubmit: submit, key: "composer" }),
  ]);
}

function ThreadView({ token, threadId, onBack }) {
  const [thread, setThread] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [missing, setMissing] = React.useState(false);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const log = React.useRef(null);

  const load = React.useCallback((quiet) => requestJson("/me/messages/" + threadId, { token }).then((data) => {
    setThread(data.thread || null);
    setMessages(Array.isArray(data.messages) ? data.messages : []);
    setMissing(false);
    announceInboxChanged();
  }).catch((caught) => {
    if (caught?.status === 404) setMissing(true);
    else if (!quiet) setError("Could not load this conversation.");
  }), [threadId, token]);

  React.useEffect(() => {
    load(false);
    const timer = window.setInterval(() => load(true), 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  React.useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  async function submit(event) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await requestJson("/me/messages/" + threadId, { token, method: "POST", body: { body } });
      setText("");
      if (saved?.message) {
        setMessages((current) => current.some((row) => row.id === saved.message.id) ? current : current.concat(saved.message));
      }
      announceInboxChanged();
    } catch (caught) {
      setError(sendError(caught));
    } finally {
      setBusy(false);
    }
  }

  const name = thread?.with?.name || "Member";
  return h("section", { className: "member-inbox member-thread", "aria-label": "Conversation with " + name }, [
    h("button", { type: "button", className: "member-parent-link", onClick: onBack, key: "back" }, [
      h(ChevronLeft, { size: 16, "aria-hidden": true, key: "icon" }),
      "Inbox",
    ]),
    h("h2", { key: "who" }, missing ? "Conversation unavailable" : name),
    missing
      ? h("p", { className: "player-card-meta", key: "missing" }, "This conversation isn't available.")
      : h("div", { className: "member-message-log", ref: log, "aria-label": "Messages", key: "log" }, messages.map((message) => h("div", {
        className: "member-bubble" + (message.mine ? " is-mine" : ""),
        key: message.id,
      }, [
        h("p", { key: "body" }, message.body),
        messageWhen(message.at) ? h("time", { dateTime: message.at, key: "time" }, messageWhen(message.at)) : null,
      ]))),
    missing ? null : h(Composer, { label: "Reply", value: text, busy, error, onChange: setText, onSubmit: submit, key: "composer" }),
  ]);
}

function InboxView({ token, onOpen }) {
  const [threads, setThreads] = React.useState([]);
  const [notices, setNotices] = React.useState([]);
  const [composing, setComposing] = React.useState(false);
  const [status, setStatus] = React.useState("loading");

  const loadThreads = React.useCallback(() => requestJson("/me/messages", { token }).then((data) => {
    setThreads(Array.isArray(data?.threads) ? data.threads : []);
    setStatus("ready");
  }).catch(() => setStatus("error")), [token]);

  React.useEffect(() => {
    let live = true;
    loadThreads();
    requestJson("/me/notices", { token }).then((data) => {
      if (!live) return;
      const rows = Array.isArray(data?.notices) ? data.notices : [];
      setNotices(rows);
      if (rows.some((row) => !row.seen)) {
        requestJson("/me/notices/seen", { token, method: "POST", body: {} })
          .then(() => announceInboxChanged())
          .catch(() => {});
      }
    }).catch(() => {});
    const timer = window.setInterval(loadThreads, 20000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [loadThreads, token]);

  function openNotice(notice) {
    requestJson("/me/notices/seen", { token, method: "POST", body: { ids: [notice.id] } }).catch(() => {});
    announceInboxChanged();
    const destination = memberDestination(notice.href);
    if (!destination) return;
    if (destination.tab === "messages" && /^\d{1,12}$/.test(destination.thread || "")) {
      onOpen(destination.thread);
      return;
    }
    selectDashboardTab(destination.tab);
  }

  return h("section", { className: "member-inbox", "aria-label": "Messages" }, [
    h("div", { className: "member-inbox-toolbar", key: "toolbar" }, [
      h("p", { className: "player-card-meta", key: "note" }, "Direct messages stay between the two of you."),
      h("button", {
        type: "button",
        className: "player-btn" + (composing ? " primary" : ""),
        "aria-expanded": composing ? "true" : "false",
        onClick: () => setComposing((open) => !open),
        key: "new",
      }, composing ? "Close" : "New message"),
    ]),
    composing ? h(PeopleSearch, { token, onPick: (person) => onOpen({ draft: person }), key: "people" }) : null,
    notices.length ? h("div", { className: "member-inbox-updates", key: "updates" }, [
      h("h2", { key: "title" }, "Updates"),
      h("div", { className: "member-list-rows", key: "rows" }, notices.map((notice) => h("button", {
        type: "button",
        className: "member-list-row" + (notice.seen ? "" : " is-unread"),
        key: notice.id,
        onClick: () => openNotice(notice),
      }, [
        h("span", { className: "member-list-copy", key: "copy" }, [
          h("span", { className: "member-list-name", key: "title" }, notice.title),
          h("small", { className: "member-list-meta", key: "body" }, notice.body),
        ]),
        h("span", { className: "member-list-date", key: "when" }, messageWhen(notice.at)),
      ]))),
    ]) : null,
    h("div", { className: "member-inbox-threads", key: "threads" }, [
      h("h2", { key: "title" }, "Conversations"),
      status === "loading" ? h("p", { className: "player-card-meta", key: "loading" }, "Loading messages…") : null,
      status === "error" ? h("p", { className: "player-card-meta", role: "status", key: "error" }, "Could not load messages.") : null,
      status === "ready" && !threads.length ? h("p", { className: "player-card-meta", key: "empty" }, "No messages yet. Start one with a member.") : null,
      threads.length ? h("div", { className: "member-list-rows", key: "rows" }, threads.map((thread) => h("button", {
        type: "button",
        className: "member-list-row" + (thread.unread ? " is-unread" : ""),
        key: thread.id,
        onClick: () => onOpen(String(thread.id)),
      }, [
        h("span", { className: "member-list-copy", key: "copy" }, [
          h("span", { className: "member-list-name", key: "name" }, thread.with?.name || "Member"),
          h("small", { className: "member-list-meta", key: "preview" }, (thread.fromMe ? "You: " : "") + (thread.preview || "")),
        ]),
        h("span", { className: "member-thread-side", key: "side" }, [
          h("span", { className: "member-list-date", key: "when" }, messageWhen(thread.at)),
          thread.unread ? h("span", { className: "member-unread-count", key: "unread" }, thread.unread > 9 ? "9+" : String(thread.unread)) : null,
        ]),
      ]))) : null,
    ]),
  ]);
}

export function MemberMessagesPanel({ token }) {
  const [threadId, setThreadId] = React.useState(threadFromHash);
  const [draft, setDraft] = React.useState(null);

  React.useEffect(() => {
    const sync = () => {
      setThreadId(threadFromHash());
      setDraft(null);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  function open(target) {
    if (target && typeof target === "object") {
      setDraft(target.draft || null);
      setThreadId(null);
      setMessagesHash(null, true);
      return;
    }
    setDraft(null);
    setThreadId(target);
    setMessagesHash(target, !target);
  }

  if (draft) return h(DraftView, { token, person: draft, onBack: () => setDraft(null), onSent: (id) => open(id) });
  if (threadId) return h(ThreadView, { token, threadId, onBack: () => open(null) });
  return h(InboxView, { token, onOpen: open });
}
