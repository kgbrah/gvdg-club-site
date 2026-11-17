const entry = (key, label, group, options = {}) => ({ key, label, group, hash: key, ...options });

export const MEMBER_DESTINATIONS = [
  entry("overview", "Home", "overview", { hash: "home" }),
  entry("play", "Play", "play", { terms: "start join watch round code course map recent replay film" }),
  entry("course-discovery", "Course discovery", "play", { context: "course", terms: "find courses reviews amenities accessibility difficulty favorites restrooms parking step free" }),
  entry("community", "Community", "more", { terms: "friends member directory profile privacy share social milestones streak" }),
  entry("practice", "Practice", "play", { terms: "putting fieldwork measured distance throw session repetitions attempts trends putting drill" }),
  entry("my-bag", "My bag", "play", { terms: "disc inventory equipment mold manufacturer brand model plastic weight archive" }),
  entry("events", "Events", "events", { terms: "register registration sign up upcoming entries schedule tournament" }),
  entry("season", "Stats", "season", { hash: "stats", terms: "season history score metrics shot putting rating trend filter export" }),
  entry("more", "Club", "more", { hash: "club-hub" }),
  entry("club", "Club directory", "more", { hash: "directory", terms: "members roster courses club conditions meeting minutes" }),
  entry("board", "Message board", "more", { terms: "chat post discussion member board" }),
  entry("messages", "Messages", "more", { hash: "messages", terms: "direct message inbox dm text notification alert unread" }),
  entry("tee", "Tee signs", "more", { terms: "course photo capture contribution" }),
  entry("tags", "Bag tags", "more", { terms: "challenge claim ladder" }),
  entry("standings", "Club standings", "more", { terms: "leaderboard league results" }),
  entry("leagues", "League schedule", "events", { terms: "doubles seasons fixtures calendar" }),
  entry("results", "Event results", "events", { terms: "finishes standings placement history" }),
  entry("account", "Account", "account", { terms: "membership profile passkey notifications password logout sign out" }),
  entry("wallet", "Wallet", "account", { terms: "money balance credit store transactions purchases payouts" }),
  entry("appearance", "Appearance", "account", { terms: "theme color dark light background customize disc bag" }),
  entry("install", "Install app", "account", { terms: "PWA home screen phone device Android iPhone help notifications" }),
  entry("imports", "Imported history", "season", { terms: "UDisc import CSV upload score rounds" }),
];

export const ADMIN_DESTINATIONS = [
  entry("today", "Today", "today", { terms: "home needs you alerts current event" }),
  entry("events", "Event list", "events", { terms: "calendar schedule event workspace" }),
  entry("create", "New event", "events", { terms: "new create add tournament competition casual" }),
  entry("import", "Import event", "events", { terms: "PDGA UDisc import sync tournament" }),
  entry("leagues-mgmt", "League seasons", "events", { terms: "schedule doubles league night" }),
  entry("registration", "Registration", "events", { terms: "event sign up roster entries fees payment payouts", context: "event" }),
  entry("check-in", "Check-in", "events", { terms: "check desk attendance arrival paid roster", context: "event", pane: "registration" }),
  entry("scoring", "Live scoring", "events", { terms: "start round score cards putting scores scoring", context: "event" }),
  entry("results", "Results", "events", { terms: "finished standings finalize scores publish", context: "event", pane: "scoring" }),
  entry("members", "Members", "members", { terms: "roster profile PIN role access membership" }),
  entry("applications", "Member applications", "members", { terms: "approve reject pending requests membership", pane: "members", focus: "applications" }),
  entry("shop", "Inventory", "money", { terms: "shop stock products pro shop disc" }),
  entry("orders", "Orders", "money", { terms: "fulfill handoff pickup shelf checkout order" }),
  entry("wallets", "Wallets", "money", { terms: "store credit member balances adjustment transaction" }),
  entry("fundraisers", "Campaigns", "money", { terms: "fundraiser donation" }),
  entry("more", "Tools", "more", { hash: "tools", terms: "admin help account settings" }),
  entry("courses", "Courses", "more", { terms: "course catalog add edit map UDisc", context: "course" }),
  entry("course-health", "Course health", "more", { terms: "course maintenance repairs tasks backlog play counts participation impact usage coverage verification stale report CSV PDGA SSA rating baseline rated rounds", context: "course" }),
  entry("layouts", "Layouts", "more", { terms: "course edit pars distances tee basket positions", context: "course" }),
  entry("tee-signs", "Tee signs", "more", { terms: "review approve rejects candidates photo photos course", context: "course" }),
  entry("bag-tags", "Bag tags", "more", { terms: "challenge claim requests ladder" }),
  entry("meetings", "Meeting minutes", "more", { terms: "notes minutes minutes upload" }),
  entry("data-archive", "Data archive", "more", { terms: "export archive backup destinations" }),
  entry("review-queue", "Review queue", "more", { terms: "moderate publish hide course reviews reports amenity amenities difficulty accessibility" }),
];

export const MEMBER_PRIMARY = ["overview", "play", "events", "season", "more"];
export const ADMIN_PRIMARY = [
  { key: "today", label: "Today" },
  { key: "events", label: "Events" },
  { key: "members", label: "Members" },
  { key: "shop", label: "Money" },
  { key: "more", label: "Tools" },
];

const MEMBER_ACTIONS = [
  { label: "Start a round", href: "score.html?start=1", terms: "practice play score" },
  { label: "Club website", href: "index.html", terms: "public home" },
  { label: "Pro shop", href: "pro-shop.html", terms: "buy discs merchandise equipment" },
  { label: "Help", action: "help", terms: "support Crotts" },
  { label: "Admin portal", href: "admin.html", terms: "manage administrator", admin: true },
];
const ADMIN_ACTIONS = [
  { label: "Member app", href: "gvdg-members.html", terms: "back switch" },
  { label: "Help", action: "help", terms: "support Crotts" },
  { label: "Account controls", key: "more", terms: "theme notifications logout sign out" },
];

function choices(role) {
  return role === "admin" ? ADMIN_DESTINATIONS : MEMBER_DESTINATIONS;
}

export function destination(role, value) {
  const key = String(value || "").toLowerCase();
  if (role === "admin" && key === "money") return choices(role).find((row) => row.key === "shop");
  return choices(role).find((row) => row.key === key || row.hash === key) || choices(role)[0];
}

function positiveId(value) {
  const text = String(value ?? "");
  return /^\d{1,12}$/.test(text) && Number(text) > 0 ? String(Number(text)) : null;
}

export function readAppRoute(role, location) {
  const [fragment, hashQuery = ""] = String(location.hash || "").slice(1).split("?", 2);
  const parts = fragment.split("/");
  const query = new URLSearchParams(location.search || "");
  for (const [key, value] of new URLSearchParams(hashQuery)) query.set(key, value);
  const row = destination(role, parts[0] || query.get("tab"));
  const eventId = positiveId(query.get("event") ?? query.get("eventId") ?? (row.context === "event" ? parts[1] : null));
  const courseId = positiveId(query.get("course") ?? query.get("courseId") ?? (row.context === "course" ? parts[1] : null));
  const filter = role === "admin" && ["new", "candidate", "applications", "requests", "challenges", "stock", "handoff", "alerts"].includes(query.get("filter"))
    ? query.get("filter") : null;
  return { tab: row.key, eventId, courseId, filter };
}

export function appHref(role, tab, context = {}) {
  const row = destination(role, tab);
  const params = new URLSearchParams();
  const eventId = positiveId(context.eventId);
  const courseId = positiveId(context.courseId);
  if (eventId) params.set("event", eventId);
  if (courseId) params.set("course", courseId);
  if (context.filter) params.set("filter", context.filter);
  return "#" + row.hash + (params.size ? "?" + params : "");
}

export function navigationHref(role, location, tab, context) {
  const query = new URLSearchParams(location.search || "");
  ["tab", "event", "eventId", "course", "courseId", "filter"].forEach((key) => query.delete(key));
  return location.pathname + (query.size ? "?" + query : "") + appHref(role, tab, context);
}

export function findTools(input, { role = "member", isAdmin = false } = {}) {
  const ignored = new Set(["a", "an", "for", "how", "my", "the", "to"]);
  const terms = (String(input || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((term) => !ignored.has(term));
  if (!terms.length) return [];
  const items = role === "admin" ? (isAdmin ? ADMIN_DESTINATIONS.concat(ADMIN_ACTIONS) : []) : MEMBER_DESTINATIONS.concat(MEMBER_ACTIONS.filter((row) => !row.admin || isAdmin));
  return items.map((item) => {
    const label = item.label.toLowerCase();
    const words = (label + " " + (item.terms || "")).toLowerCase().match(/[a-z0-9]+/g) || [];
    const match = terms.every((term) => words.some((word) => word.startsWith(term)));
    const priority = label === terms.join(" ") ? 3 : terms.every((term) => label.includes(term)) ? 2 : 1;
    return { item, rank: match ? priority : 0 };
  }).filter(({ rank }) => rank).sort((a, b) => b.rank - a.rank).slice(0, 8).map(({ item }) => item);
}
