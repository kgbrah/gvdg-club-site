// Karma next to every player's name, across the app and the public site: a small chip ("✦ 40", read as "40 karma")
// for anyone with karma (Lost & Found returns plus confirmed club donations); nothing for everyone else.
//
// One directory, GET /karma -> { players: { [key]: karma }, traders: { [traderKey]: karma } }, loaded once a page and
// kept for a few minutes in this tab (sessionStorage), so every chip on every screen reads the same numbers. Players
// are keyed by the anonymous handicapKey(memberId), as live scoring already does; a page that has a member id or a
// PDGA number computes the same key, and payloads with names only carry `karmaKey`.
import React from "react";

import { resolveApiBase } from "./api-base.js";
import { handicapKey } from "./handicap.js";

const h = React.createElement;
const STORE_KEY = "gvdg_karma_directory";
const FRESH_MS = 5 * 60 * 1000;
export const EMPTY_KARMA = Object.freeze({ players: Object.freeze({}), traders: Object.freeze({}) });

/** Only well-formed keys and positive whole numbers survive (the directory is public data, but still checked). */
export function cleanKarmaDirectory(data) {
  const out = { players: {}, traders: {} };
  for (const kind of ["players", "traders"]) {
    const source = data && typeof data === "object" ? data[kind] : null;
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      const karma = Number(value);
      if (/^[0-9a-f]{16,32}$/i.test(key) && Number.isInteger(karma) && karma > 0) out[kind][key] = karma;
    }
  }
  return out;
}

function readStored() {
  try {
    const stored = JSON.parse(globalThis.sessionStorage?.getItem(STORE_KEY) || "null");
    return stored && Number.isFinite(stored.at) && stored.data ? { at: stored.at, data: cleanKarmaDirectory(stored.data) } : null;
  } catch {
    return null;
  }
}

let current = readStored();
let pending = null;
const listeners = new Set();

/** The directory (fresh within FRESH_MS); never throws: no connection keeps the last copy, or none. */
export function loadKarmaDirectory(fetcher = globalThis.fetch) {
  if (current && Date.now() - current.at < FRESH_MS) return Promise.resolve(current.data);
  if (pending) return pending;
  if (typeof fetcher !== "function") return Promise.resolve(current?.data ?? EMPTY_KARMA);
  pending = fetcher(resolveApiBase({ datasetKeys: ["apiBase", "authBase"] }) + "/karma", { headers: { Accept: "application/json" } })
    .then((response) => (response && response.ok ? response.json() : null))
    .then((json) => {
      if (json) {
        current = { at: Date.now(), data: cleanKarmaDirectory(json) };
        try { globalThis.sessionStorage?.setItem(STORE_KEY, JSON.stringify(current)); } catch { /* memory copy is enough */ }
        for (const listener of listeners) listener(current.data);
      }
      return current?.data ?? EMPTY_KARMA;
    })
    .catch(() => current?.data ?? EMPTY_KARMA)
    .finally(() => { pending = null; });
  return pending;
}

export function useKarmaDirectory() {
  const [data, setData] = React.useState(() => current?.data ?? EMPTY_KARMA);
  React.useEffect(() => {
    let live = true;
    const update = (next) => { if (live) setData(next); };
    listeners.add(update);
    void loadKarmaDirectory().then(update);
    return () => { live = false; listeners.delete(update); };
  }, []);
  return data;
}

const digits = (value) => String(value ?? "").replace(/\D/g, "");

/** A player's karma: by `karmaKey` (from the payload), a member id, a PDGA number, or a marketplace trader key; 0 if none. */
export function karmaOf(directory, who) {
  if (!who || !directory) return 0;
  const players = directory.players || {};
  const keys = [who.karmaKey, who.memberId ? handicapKey(who.memberId) : "", digits(who.pdga) ? handicapKey("m_" + digits(who.pdga)) : ""];
  for (const key of keys) if (key && players[key]) return players[key];
  return who.traderKey && directory.traders ? directory.traders[who.traderKey] || 0 : 0;
}

/** " ✦ 40" for text that can't hold a chip (a select option, a canvas); "" when none. */
export function karmaSuffix(directory, who) {
  const karma = karmaOf(directory, who);
  return karma > 0 ? ` ✦ ${karma}` : "";
}

/**
 * The chip itself. Pass `karma` when the payload already has it, or any of karmaKey / memberId / pdga / traderKey.
 * Renders nothing for 0. The visible text is "✦ 40"; screen readers and hover read "40 karma".
 */
export function KarmaChip({ karma = null, karmaKey = "", memberId = "", pdga = "", traderKey = "" }) {
  const directory = useKarmaDirectory();
  const value = karma != null ? Number(karma) : karmaOf(directory, { karmaKey, memberId, pdga, traderKey });
  if (!Number.isFinite(value) || value <= 0) return null;
  return h("span", { className: "karma-chip", "data-karma": value, title: `${value} karma` }, [
    h("span", { "aria-hidden": "true", key: "mark" }, "✦"),
    h("span", { key: "n" }, String(value)),
    h("span", { className: "karma-chip-label", key: "label" }, " karma"),
  ]);
}
