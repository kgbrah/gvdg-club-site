import React from "react";
import { request } from "./api.js";
import { readMemberToken, memberTokenExpired, memberTokenSubject, TOKEN_KEY } from "../shared/member-session.js";
import { drainRoundJournal, resetJournalRetries } from "../score-app/round-recovery.js";
import { createPracticeStorage, EMPTY_PRACTICE, isPracticeSnapshot, practiceDraftView } from "./practice-model.js";

const PATH = "/me/practice";
const EMPTY_STATE = { scope: null, snapshot: null, drafts: [], status: "loading", error: "" };

async function practiceRequest(path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await request(path, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, data, retryAfter: response.headers.get("Retry-After") };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

export function usePracticeWorkspace(token, open) {
  const [identity, setIdentity] = React.useState(null);
  const owner = identity && identity.token === token ? identity.owner : null;
  const [state, setState] = React.useState(EMPTY_STATE);
  const activePage = React.useRef(open);
  activePage.current = open;
  const [credentialVersion, credentialChanged] = React.useReducer((version) => version + 1, 0);
  const verifiedRef = React.useRef("");
  React.useEffect(() => {
    if (!token || token !== readMemberToken()) return undefined;
    let cancelled = false;
    const offlineSub = memberTokenSubject(token);
    if (!owner && !navigator.onLine && offlineSub && !memberTokenExpired(token)) {
      setIdentity({ token, owner: offlineSub });
    }
    async function identify() {
      if (cancelled || token !== readMemberToken()) return;
      if (!navigator.onLine) {
        const sub = memberTokenSubject(token);
        if (!owner && sub && !memberTokenExpired(token)) setIdentity({ token, owner: sub });
        return;
      }
      if (verifiedRef.current === token && owner) return;
      const result = await practiceRequest("/me", { token });
      if (cancelled || token !== readMemberToken()) return;
      if (result.status === 401) {
        verifiedRef.current = "";
        setIdentity(null);
        return;
      }
      const sub = result.data?.sub;
      if (result.ok && typeof sub === "string" && sub && result.data.mustChangePin !== true) {
        verifiedRef.current = token;
        setIdentity({ token, owner: sub });
      }
    }
    void identify();
    window.addEventListener("online", identify);
    return () => {
      cancelled = true;
      window.removeEventListener("online", identify);
    };
  }, [token, owner, credentialVersion]);

  const environment = React.useMemo(() => {
    if (!owner || !token || token !== readMemberToken()) return null;
    let storage;
    try { storage = createPracticeStorage(window.localStorage, owner); }
    catch { storage = null; }
    const scope = { owner, token };
    let active = false;
    let snapshot = null;
    let timer = null;
    let pending = null;
    let refreshTicket = 0;
    let wake = null;
    let error = "";
    let status = "loading";
    const valid = () => active && readMemberToken() === token;

    function render() {
      if (!valid()) return;
      let drafts = [];
      try { if (storage) drafts = storage.journal.entries(); }
      catch { error = "This phone’s practice storage is unavailable."; }
      setState({ scope, snapshot, drafts, status, error });
    }

    async function refresh() {
      if (!valid() || !navigator.onLine) return;
      const ticket = ++refreshTicket;
      const response = await practiceRequest(PATH, { token });
      if (ticket !== refreshTicket || !valid()) return;
      if (!response.ok || response.data?.owner !== owner) {
        status = response.status === 401 || response.status === 403 ? "auth" : "offline";
        render();
        return;
      }
      const data = response.data;
      if (!isPracticeSnapshot(data, owner)) {
        status = "offline";
        render();
        return;
      }
      snapshot = data;
      status = "ready";
      try { storage?.save(data); } catch { /* the server snapshot remains valid */ }
      render();
    }

    function schedule(nextAt) {
      if (!valid() || !nextAt) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void sync();
      }, Math.max(nextAt - Date.now(), 100));
    }

    async function sync(force) {
      if (!valid() || !storage || !navigator.onLine) return;
      if (force) wake = wake === "manual" ? wake : force;
      if (pending) return pending;
      clearTimeout(timer);
      timer = null;
      async function perform() {
        if (!valid()) return;
        if (wake) {
          resetJournalRetries(storage.journal, { includeErrors: wake === "manual" });
          wake = null;
          render();
        }
        let saved = false;
        const nextAt = await drainRoundJournal(storage.journal, async (item) => {
          if (!valid()) return null;
          const response = await practiceRequest(PATH + "/mutations", {
            token, method: "POST", body: { owner, kind: item.kind, opId: item.id, ...item.body },
          });
          if (response.ok && (response.data?.id !== item.body.id || response.data?.revision !== item.body.expectedRevision + 1)) {
            return { ok: false, status: 503 };
          }
          return response;
        }, {
          active: valid,
          online: () => navigator.onLine,
          onResult(item, outcome, response) {
            if (outcome === "saved") {
              saved = true;
              ++refreshTicket;
              if (!snapshot) snapshot = { ...EMPTY_PRACTICE, owner };
              const key = item.kind === "throw" ? "throws" : "putting";
              const rows = item.kind === "disc" ? snapshot.discs : snapshot[key].items;
              const updated = rows.filter((row) => row.id !== item.body.id);
              if (item.body.action === "save") updated.push({
                id: item.body.id, kind: item.kind, revision: item.body.expectedRevision + 1, record: item.body.record,
              });
              if (item.kind === "disc") snapshot = { ...snapshot, discs: updated };
              else snapshot = { ...snapshot, [key]: { ...snapshot[key], items: updated } };
            } else if (outcome === "pending" && (!response.status || response.status >= 500)) status = "offline";
            render();
          },
        });
        schedule(nextAt);
        if (saved) await refresh();
      }
      pending = (async () => {
        try {
          if (navigator.locks?.request) {
            await navigator.locks.request(storage.journal.lockName, { ifAvailable: true }, (lock) => lock ? perform() : schedule(Date.now() + 1000));
          } else await perform();
        } catch {
          error = "Couldn’t update the saved practice changes on this phone.";
          render();
          schedule(Date.now() + 5000);
        }
      })();
      try { await pending; }
      finally {
        pending = null;
        if (wake && !timer && valid() && navigator.onLine) void sync();
      }
    }

    return {
      scope,
      start() {
        active = true;
        try { snapshot = storage?.load() || null; }
        catch { error = "This phone’s saved practice data could not be read."; }
        status = navigator.onLine ? (snapshot ? "ready" : "loading") : "offline";
        render();
        void sync("boot");
      },
      stop() {
        active = false;
        ++refreshTicket;
        clearTimeout(timer);
        timer = null;
      },
      refresh,
      sync,
      offline() {
        status = "offline";
        render();
      },
      changed(key) {
        if (!valid() || !storage?.matchesStorageKey(key)) return;
        try { snapshot = storage.load() || snapshot; } catch { /* report through render */ }
        render();
        void sync();
      },
      stage(kind, edit) {
        if (!valid() || !storage) return "This phone couldn’t save the draft.";
        try {
          storage.append(kind, edit);
          error = "";
          render();
          void sync();
          return "";
        } catch (failure) {
          return failure.message === "draft_limit"
            ? "Sync your 100 saved changes before adding more."
            : "This phone couldn’t save the draft. Keep the form open and try again.";
        }
      },
      async discard(id) {
        if (!storage || !valid()) return;
        const remove = () => {
          if (!valid()) return;
          const item = storage.journal.entries().find((entry) => entry.id === id && (entry.state === "error" || entry.state === "auth"));
          if (item) storage.journal.remove(item);
          render();
        };
        try {
          if (navigator.locks?.request) await navigator.locks.request(storage.journal.lockName, remove);
          else { await pending; remove(); }
        } catch { error = "Couldn’t discard the change from this phone."; render(); }
        void sync();
      },
      async loadOlder(kind) {
        if (!valid() || !snapshot) return;
        const key = kind === "throw" ? "throws" : "putting";
        const cursor = snapshot[key].next;
        if (!cursor) return;
        const response = await practiceRequest(PATH + "?" + new URLSearchParams({ kind, before: cursor }), { token });
        if (!valid() || snapshot[key].next !== cursor) return;
        if (!response.ok || response.data?.owner !== owner || !Array.isArray(response.data.items)) {
          error = "Older records couldn’t load.";
          render();
          return;
        }
        const rows = new Map(snapshot[key].items.map((row) => [row.id, row]));
        for (const row of response.data.items) rows.set(row.id, row);
        snapshot = { ...snapshot, [key]: { items: [...rows.values()], next: response.data.next } };
        error = "";
        render();
      },
      async download() {
        if (!valid()) return null;
        const response = await practiceRequest(PATH + "/export", { token });
        if (!valid() || !response.ok || !response.data?.version) return null;
        return { ...response.data, drafts: storage?.journal.entries() || [] };
      },
    };
  }, [owner, token, credentialVersion]);

  React.useEffect(() => {
    environment?.start();
    const changed = (event) => {
      if (event.key === TOKEN_KEY) credentialChanged();
      else environment?.changed(event.key);
    };
    const online = () => { void environment?.sync("online"); if (activePage.current) void environment?.refresh(); };
    const offline = () => environment?.offline();
    window.addEventListener("storage", changed);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      environment?.stop();
      window.removeEventListener("storage", changed);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [environment]);

  React.useEffect(() => {
    if (open) void environment?.refresh();
  }, [environment, open]);

  const current = environment && state.scope === environment.scope && readMemberToken() === token;
  const visible = current ? state : EMPTY_STATE;
  return {
    ...visible,
    data: practiceDraftView(visible.snapshot, visible.drafts),
    stage: (...args) => environment?.stage(...args) || (environment ? "" : "Sign in again to save your practice."),
    sync: () => environment?.sync("manual"),
    discard: (id) => environment?.discard(id),
    loadOlder: (kind) => environment?.loadOlder(kind),
    download: () => environment?.download(),
  };
}
