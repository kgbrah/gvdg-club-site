export interface CrottsAction {
  readonly href: string;
  readonly id: string;
  readonly label: string;
}

export interface LiveEventHint {
  readonly id?: number | string | null;
  readonly name?: string | null;
}

const ALLOWED_PAGES = new Set([
  "events.html",
  "gvdg-members.html",
  "index.html",
  "pro-shop.html",
  "ryder-cup.html",
  "score.html",
]);

const CLUB_MAIL = "mailto:greenvillediscgolf@gmail.com";

function eventId(value: unknown): string {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

function eventName(value: unknown, fallback: string): string {
  const name = String(value ?? "").trim();
  return name || fallback;
}

export function sanitizeCrottsHref(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.toLowerCase() === CLUB_MAIL) return CLUB_MAIL;
  if (/^[a-z]+:/i.test(raw) || raw.startsWith("//") || raw.includes("\\") || raw.includes("..")) return "";

  const hashIndex = raw.indexOf("#");
  const queryIndex = raw.indexOf("?");
  const pathEnd = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? raw.length;
  const path = raw.slice(0, pathEnd);
  if (!ALLOWED_PAGES.has(path)) return "";

  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined) : "";
  const hash = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";

  if (path === "score.html") {
    if (!query) return "score.html";
    const params = new URLSearchParams(query);
    const keys: string[] = [];
    params.forEach((_value, key) => keys.push(key));
    if (keys.some((key) => key !== "event" && key !== "watch")) return "";
    const event = eventId(params.get("event"));
    const watch = String(params.get("watch") || "");
    if (params.has("event") && !event) return "";
    if (params.has("watch") && watch !== "1") return "";
    if (event && watch === "1") return `score.html?event=${event}&watch=1`;
    if (event) return `score.html?event=${event}`;
    return "score.html";
  }

  if (path === "events.html") {
    const match = hash.match(/^event\/(\d+)$/);
    return match ? `events.html#event/${match[1]}` : "events.html";
  }

  if (path === "gvdg-members.html") {
    return hash.toLowerCase() === "apply" ? "gvdg-members.html#apply" : "gvdg-members.html";
  }

  if (query || hash) return "";
  return path;
}

export function sanitizeCrottsActions(actions: unknown): CrottsAction[] {
  if (!Array.isArray(actions)) return [];
  const out: CrottsAction[] = [];
  const seen = new Set<string>();
  for (const row of actions) {
    if (!row || typeof row !== "object") continue;
    const href = sanitizeCrottsHref((row as CrottsAction).href);
    const label = String((row as CrottsAction).label ?? "").trim().slice(0, 80);
    const id = String((row as CrottsAction).id ?? "").trim().slice(0, 40);
    if (!href || !label || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, id: id || href, label });
    if (out.length >= 4) break;
  }
  return out;
}

export function suggestCrottsActions(opts: {
  liveEvents?: readonly LiveEventHint[];
  message: string;
  openEvents?: readonly LiveEventHint[];
}): CrottsAction[] {
  const text = String(opts.message || "").toLowerCase();
  const live = Array.isArray(opts.liveEvents) ? opts.liveEvents : [];
  const open = Array.isArray(opts.openEvents) ? opts.openEvents : [];
  const proposed: CrottsAction[] = [];

  const wantsScore = /\b(scorecard|keep score|start a round|casual round)\b/.test(text) || (/\bscore\b/.test(text) && !/\bwatch\b/.test(text));
  const wantsWatch = /\b(watch|spectat|follow along|leaderboard)\b/.test(text);
  const wantsRegister = /\b(register|sign up|sign-up|league night)\b/.test(text);
  const wantsEvents = /\b(event|schedule|what'?s on|calendar|upcoming)\b/.test(text);
  const wantsJoin = /\b(join the club|become a member|apply|create (an? )?(app )?login|membership)\b/.test(text);
  const wantsMembers = /\b(log ?in|sign in|members page|my season|my stats|dashboard)\b/.test(text);
  const wantsRyder = /\bryder\b/.test(text);
  const wantsShop = /\b(shop|pro shop|store credit|wallet)\b/.test(text);
  const wantsContact = /\b(email|contact|reach (the )?club)\b/.test(text);

  if (wantsWatch || wantsScore) {
    for (const event of live.slice(0, 3)) {
      const id = eventId(event.id);
      if (!id) continue;
      const name = eventName(event.name, "live round");
      if (wantsWatch) {
        proposed.push({ id: `watch-${id}`, label: `Watch ${name}`, href: `score.html?event=${id}&watch=1` });
      }
      if (wantsScore) {
        proposed.push({ id: `score-${id}`, label: `Keep score: ${name}`, href: `score.html?event=${id}` });
      }
    }
    if (wantsScore && !live.length) {
      proposed.push({ id: "casual", label: "Start a casual round", href: "score.html" });
    }
  }

  if (wantsRegister || wantsEvents) {
    const first = open[0];
    const id = first ? eventId(first.id) : "";
    if (id) proposed.push({ id: `event-${id}`, label: `Register: ${eventName(first?.name, "open event")}`, href: `events.html#event/${id}` });
    proposed.push({ id: "events", label: "Open events", href: "events.html" });
  }

  if (wantsJoin) proposed.push({ id: "apply", label: "Create your app login", href: "gvdg-members.html#apply" });
  if (wantsMembers) proposed.push({ id: "members", label: "Open members", href: "gvdg-members.html" });
  if (wantsRyder) proposed.push({ id: "ryder", label: "Ryder Cup scoreboard", href: "ryder-cup.html" });
  if (wantsShop) proposed.push({ id: "shop", label: "Open the Pro Shop", href: "pro-shop.html" });
  if (wantsContact) proposed.push({ id: "email", label: "Email the club", href: CLUB_MAIL });

  return sanitizeCrottsActions(proposed);
}
