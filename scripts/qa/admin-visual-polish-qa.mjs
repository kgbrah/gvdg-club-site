import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { ADMIN_DESTINATIONS, appHref } from "../../src/shared/app-navigation.js";

const photos = process.env.GVDG_ADMIN_SCREENSHOTS;
const fontDir = process.env.GVDG_ADMIN_FONT_DIR;
if (photos) await mkdir(photos, { recursive: true });
const token = "qa-admin";
const date = new Date().toISOString().slice(0, 10);
const course = { id: 7, name: "River Park", location: "Greenville, NC", udisc_course_id: "23" };
const events = [
  { id: 42, name: "River Park Open", status: "live", type: "tournament", course_id: 7, course_name: course.name, layout_id: 9, date },
  { id: 41, name: "Autumn Doubles", status: "scheduled", type: "league", course_id: 7, layout_id: 9, date: "2099-11-21" },
  { id: 40, name: "October Club Championship", status: "final", type: "tournament", course_id: 7, layout_id: 9, date: "2025-10-21" },
];
const people = [
  { memberId: "m_taylor", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: true },
  { memberId: "m_jordan", name: "Jordan Reyes", pdgaNo: "234567" },
  { memberId: "m_avery", name: "Avery Brooks", pdgaNo: "345678" },
];
const holes = Array.from({ length: 18 }, (_, index) => ({ hole: index + 1, par: 3, distance_ft: 315 + index * 12 }));
const layouts = [{ id: 9, course_id: 7, name: "Blue tees", holes }];
const registration = { id: 5, member_id: "m_jordan", name: "Jordan Reyes", division: "MA2", starting_hole: 1, checked_in: false, payment_status: "paid", status: "confirmed" };
const application = { id: "application-one", name: "Cameron Taylor", pdgaNo: "456789", createdAt: date, status: "pending" };
const order = { id: 6, member_id: "m_jordan", member_name: "Jordan Reyes", status: "submitted", delivery_method: "pickup", items: [{ name_snapshot: "River fairway driver", quantity: 1, price_cents: 1800 }], total_cents: 1800, created_at: date };
const tee = { id: 3, course_id: 7, hole_number: 2, status: "candidate", created_at: date, suggestedRows: [{ layoutId: 9, tee: "Blue", target: "A", distance_ft: 317, par: 3 }] };
const review = { id: 3, courseId: 7, courseName: course.name, rating: 5, text: "Clear tee signs and a shaded practice basket.", updatedAt: date, reportCount: 0, revision: 1, state: "pending" };
const task = { id: 2, status: "open", priority: "normal", title: "Replace hole 7 tee sign", details: "Install an updated layout card.", revision: 1, dueDate: date, updatedAt: date };
const eventPlayers = people.map(({ name }, index) => ({ name, index, cardId: "c0", startingHole: 1, scores: { 1: index + 2 }, scorecards: {} }));
const standings = eventPlayers.map(({ name, index, scores }) => ({
  name, index, targetId: "p" + index, playerIndex: index, playerIndexes: [index], total: scores[1], toPar: scores[1] - 3, thru: 1, division: "MA2",
  scorecard: [{ hole: 1, par: 3, strokes: scores[1] }],
}));
const courseHealth = {
  course, window: { from: date, to: date },
  participation: { completedRounds: 12, completedPlayerEntries: 48, uniqueIdentifiedPlayers: 36, completedCompetitionRecords: 8, completedCasualCards: 4, guestEntries: 9 },
  health: { holes: 18, mappedHoles: 16, approvedPars: 15, staleApprovals: 2, approvalsReviewedInWindow: 3, pendingTeeSigns: 1, staleAfterDays: 120, layouts: [] },
  participationDefinition: "Counts completed GVDG records in the selected dates.", coverageDefinition: "Counts approved layout holes.",
};

// PDGA layout baselines (Course health). Long real names stress wrapping at 320 px with large text.
const pdgaCandidate = { courseId: 7, courseName: course.name, layoutId: 9, layoutName: "Blue tees", grade: "none", parMatches: 18, lengthMatches: 14,
  comparableHoles: 18, holes: 18, totalDiffPct: 5.1, meanDiffFt: 31.9, reason: "Length differs by more than max(25 ft, 8%) on 4 holes" };
const pdgaOverview = {
  queue: { counts: { pending: 1, in_progress: 1, done: 14, failed: 1 }, items: [
    { tournId: 104547, source: "member-history", status: "done", attempts: 0, lastError: null, ratingsOfficial: true,
      name: "Yard Gnomes Open presented by Play it Again Sports", date: "2026-07-11", remainingFetches: 0 },
    { tournId: 86672, source: "member-history", status: "in_progress", attempts: 1, lastError: "http-503", ratingsOfficial: true,
      name: "Down East Players Cup presented by Yeet Street Discs", date: "2025-10-24", remainingFetches: 37 },
  ] },
  matches: { auto: { layouts: 3, rounds: 9 }, confirmed: { layouts: 1, rounds: 2 }, pending: { layouts: 2, rounds: 3 } },
  review: [
    { pdgaLayoutId: 761495, quality: "none", reason: "Closest layout: Length differs by more than max(25 ft, 8%) on 4 holes",
      courseName: "The Meadow at West Meadowbrook Park", layoutName: "Yard Gnome Open", holes: 18, par: 64, lengthFt: 7404, rounds: 1,
      firstDate: "2026-07-11", lastDate: "2026-07-11", eventName: "Yard Gnomes Open presented by Play it Again Sports", tournId: 104547,
      proposedLayoutId: null, candidates: [pdgaCandidate] },
    { pdgaLayoutId: 700001, quality: "ambiguous", reason: "White Pads to A-Pins and White Pads to B-Pins are equally close",
      courseName: "West Meadowbrook Park", layoutName: "Mando Madness Shorts", holes: 18, par: 56, lengthFt: 5120, rounds: 2,
      firstDate: "2025-05-26", lastDate: "2025-05-26", eventName: "Mando Madness @ the Meadow", tournId: 91304, proposedLayoutId: null,
      candidates: [{ ...pdgaCandidate, layoutId: 9, grade: "close" }, { ...pdgaCandidate, layoutId: 10, layoutName: "Blue tees to B-Pins", grade: "close" }] },
  ],
};
const pdgaCourse = { course: { ...course, state: "NC" }, layouts: [
  { id: 9, name: "Blue tees", holes: 18,
    baseline: { ssa: 49.565, ppt: 10.43, rounds: 6, officialRounds: 6, minSsa: 48.2, maxSsa: 51.0, firstDate: "2023-12-02", lastDate: "2026-07-11",
      windRounds: 5, noWindDataRounds: 1,
      provenance: "Median of the 6 most recent PDGA rounds (2023–2026), no-wind SSA 49.6; 1 round has no wind data and is used as played" },
    rounds: [{ tournId: 104547, round: 1, pdgaLayoutId: 761497, date: "2026-07-11", eventName: "Yard Gnomes Open presented by Play it Again Sports",
      pdgaLayoutName: "Ayden YGO", ssa: 49.565, ratingsStatus: "official", ratedPlayers: 41, quality: "close", reviewStatus: "auto", fitsCurrentLayout: "close",
      gustMph: 23.9, weatherStatus: "ok" },
    { tournId: 99178, round: 2, pdgaLayoutId: 740572, date: "2026-02-22", eventName: "2026 Ayden Founders' Day Classic (CEP Charity - Rated)",
      pdgaLayoutName: "Ayden Founders' Day 2026", ssa: 51.254, ratingsStatus: "official", ratedPlayers: 29, quality: "exact", reviewStatus: "auto",
      fitsCurrentLayout: "exact", gustMph: null, weatherStatus: "unavailable" }] },
  { id: 10, name: "Short tees", holes: 18, baseline: null, rounds: [] },
] };
const pdgaValidation = { status: "small-sample", matchedRounds: 9, matchedLayouts: 3, predictedRounds: 5, roundsWithoutPriorBaseline: 4, ratingPairs: 47,
  maeRating: 14.2, biasRating: -3.1, maxAbsRating: 38, ssaRounds: 5, maeSsaStrokes: 1.36, biasSsaStrokes: 0.29, formulaPairs: 61,
  formulaMaeRating: 0.3, formulaMaxAbsRating: 1, clubComparisons: 0, clubMinusPdgaSsaMean: null, clubMinusPdgaSsaMae: null, layouts: [] };

const probes = {
  today: ".admin-today-feature",
  events: ".admin-event-card-main",
  create: "#adminCreateForm",
  import: "[data-react-admin-import-controls] textarea",
  "leagues-mgmt": "[data-react-admin-league-night-form]",
  registration: "[data-react-admin-registration-settings='ready']",
  "check-in": ".admin-context .admin-desk-line",
  scoring: "[data-react-admin-scoring-live='live']",
  results: "[data-react-admin-scoring-live='final']",
  members: "[data-react-admin-members-list='ready']",
  applications: "[data-react-admin-membership-applications='ready']",
  shop: "[data-react-admin-products-list='ready']",
  orders: "[data-react-admin-orders-list='ready']",
  wallets: "[data-react-admin-wallet-recent='ready']",
  fundraisers: "[data-react-admin-fundraiser-form]",
  more: "[data-react-admin-more]",
  courses: "[data-react-admin-course-form]",
  "course-health": ".course-operator-detail",
  layouts: "[data-react-admin-layout-builder]",
  "tee-signs": ".ts-review-card",
  "bag-tags": "#admin-bag-requests",
  meetings: "[data-react-admin-meeting-form]",
  "data-archive": "[data-react-admin-data-archive-export-controls]",
  "review-queue": ".admin-community-review",
  marketplace: "[data-admin-marketplace='ready'] .admin-market-report",
  "lost-found": "[data-admin-lost-found='ready'] [data-admin-lf-report]",
};
assert.deepEqual(Object.keys(probes).sort(), ADMIN_DESTINATIONS.map((item) => item.key).sort());

const requested = [];
let fixtureMode = "";
let orderStatus = "submitted";
let checkedIn = false;
let leagueChallengeOpen = true;
let reviewPending = true;
// Admin › Scoring › Live casual rounds: a ghost (quiet for a day) and a card out on the course now.
const freshLiveRounds = () => [
  { code: "FRESH2", courseName: course.name, layoutName: "Main", startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    lastActivity: new Date(Date.now() - 6 * 60_000).toISOString(), players: ["Taylor Morgan", "Jordan Parker"], holes: 18, holesScored: 7 },
  { code: "GHOST1", courseName: "All-Terrain Disc Golf Course at Carolina Adventure World", layoutName: "Long tees", startedAt: new Date(Date.now() - 27 * 3600_000).toISOString(),
    lastActivity: new Date(Date.now() - 26 * 3600_000).toISOString(), players: ["Riley Chen"], holes: 18, holesScored: 2 },
];
let liveRounds = freshLiveRounds();
// Marketplace moderation: one open report against a listing whose long title and seller name stress 320 px.
const marketOverview = {
  counts: { openReports: 1 },
  reports: [{ id: 4, kind: "listing", targetId: 12, reason: "scam", details: "Asked me to pay with a gift card before meeting.", status: "open", createdAt: date,
    reporter: { key: "t_r", name: "Avery Brooks", kind: "member" },
    target: { title: "Innova Star Destroyer (Bottom Stamp)", status: "active", hidden: false, text: "Small ink on the back, no rim dents",
      owner: { key: "t_s", name: "Casey Guest-Longname", kind: "member", suspended: false } } }],
  hidden: { listings: [], wanted: [{ id: 3, title: "Discraft Z Zone", poster: { key: "t_g", name: "Pat Guest", kind: "guest" } }] },
  suspensions: [{ id: 1, trader: { key: "t_x", name: "Sam Spammer", kind: "guest" }, reason: "Repeated spam WANTED posts", createdAt: date, by: "Taylor Morgan" }],
  log: [{ id: 9, action: "hide", targetKind: "wanted", targetId: 3, reason: "Duplicate post", by: "Taylor Morgan", createdAt: date }],
};
// Lost & Found moderation: a report on a celebration (with its photo, removable), an AI suggestion and a return
// with karma, with long names to stress 320 px.
const lostFoundOverview = {
  counts: { openReports: 1 },
  reports: [{ id: 6, kind: "celebration", targetId: 2, reason: "privacy", details: "The photo might show a phone number.", createdAt: date,
    reporter: { key: "t_r", name: "Avery Brooks", kind: "member", karma: 0, returned: 0 },
    target: { title: "Celebration", status: "shown", hidden: false, text: "Back in the bag where it belongs!", postId: 9,
      owner: { key: "t_f", name: "Casey Guest-Longname", kind: "guest", karma: 30, returned: 3 }, photos: [{ id: 14, url: "/lost-found/photos/14" }] } }],
  matches: [{ id: 3, score: 88, status: "notified", aiVerdict: "same", codes: ["ink_phone", "mold"], reasons: ["The phone number on the disc matches", "Same mold"],
    createdAt: date, found: { id: 9, title: "Innova Champion Firebird", course: course.name }, lost: { id: 4, title: "Innova Champion Firebird", course: course.name },
    finder: { key: "t_f", name: "Casey Guest-Longname", kind: "guest", karma: 30, returned: 3 }, candidate: { key: "t_o", name: "Jordan Reyes", kind: "member", karma: 0, returned: 0 },
    via: "lost_post" }],
  hidden: { posts: [], celebrations: [] },
  karma: [{ claimId: 5, finder: { key: "t_f", name: "Casey Guest-Longname", kind: "guest", karma: 30, returned: 3 }, owner: { key: "t_o", name: "Jordan Reyes", kind: "member" },
    createdAt: date, disc: "Innova Champion Firebird", reversed: false, points: 10 }],
  log: [{ id: 2, action: "karma_reverse", targetKind: "claim", targetId: "4", reason: "Same household", by: "Taylor Morgan", createdAt: date }],
};
const errors = [];
const warnings = [];
function fixture(path, method, query, authorization, body) {
  if (path === "/me") return { sub: "m_taylor", name: people[0].name, pdgaNo: "123456", isAdmin: authorization === "Bearer " + token };
  if (path === "/events") return { events: fixtureMode === "empty" ? [] : events };
  if (path === "/admin/rounds/active") return { rounds: liveRounds };
  if (/^\/rounds\/[A-Z0-9]+\/cancel$/.test(path) && method === "POST") {
    liveRounds = liveRounds.filter((round) => !path.includes("/" + round.code + "/"));
    return { status: "none" };
  }
  // A real long live name: course pickers size to their longest option and overflowed phones (live drive, 2026-11-17).
  if (path === "/courses") return { courses: [course, { id: 8, name: "All-Terrain Disc Golf Course at Carolina Adventure World", location: "Winnsboro, SC", udisc_course_id: "24" }] };
  if (/^\/events\/\d+$/.test(path)) return { event: events.find((event) => path.endsWith("/" + event.id)) };
  if (path.endsWith("/live")) return { status: path.includes("/40/") ? "final" : "live", holes, players: eventPlayers, standings, conflicts: [], missing: [], courseName: course.name, rev: 1 };
  if (path.endsWith("/registration")) return { config: { play_format: "singles", entry_fee_cents: 2500, registration_open: true, divisions: ["MA1", "MA2"] } };
  if (path.endsWith("/registrations")) return { registrations: [{ ...registration, checked_in: checkedIn, paid_entry: checkedIn }] };
  if (path === "/admin/events/42/registrations/5" && method === "PATCH") {
    checkedIn = body.checked_in;
    return { ok: true };
  }
  if (path === "/admin/import/csv" && method === "POST") return { candidates: [{ name: "Preview Spring Open", date: "2099-04-01", type: "tournament", format: "stroke" }] };
  if (path.endsWith("/ctps")) return { ctps: [{ id: 1, hole: 5, division: "MA2", amount_cents: 800 }] };
  if (path.endsWith("/ace-pot")) return { ace_pot: { total_cents: 2800 } };
  if (path.endsWith("/layouts")) return { layouts };
  if (path.endsWith("/positions")) return { positions: [{ id: 1, label: "Blue 1 tee", kind: "tee", lat: 35.631, lng: -77.319 }] };
  if (path === "/admin/members" && method === "POST") return { member: { memberId: "m_new", name: body.name, pdgaNo: body.pdgaNo }, tempPin: "6831" };
  if (path === "/admin/members") return { members: people };
  if (path === "/admin/members/applications") return { applications: [application] };
  if (path === "/admin/orders") return { unfulfilled: 1, orders: !query.get("status") || query.get("status") === orderStatus ? [{ ...order, status: orderStatus }] : [] };
  if (path === "/admin/orders/6" && method === "PATCH") { orderStatus = body.status; return { ok: true }; }
  if (path === "/admin/shop/products") return { products: [{ id: 13, name: "River fairway driver", category: "disc", price_cents: 1800, stock: 9, active: 1, description: "A straight fairway driver." }] };
  if (path === "/admin/wallets/recent") return { transactions: [{ id: 4, member_id: "m_jordan", member_name: "Jordan Reyes", amount_cents: 1250, note: "Club payout", created_at: date }] };
  if (path === "/admin/wallets/credit") return { balance_cents: 1750 };
  if (path === "/admin/tee-signs") return { teeSigns: query.get("status") === "candidate" ? [tee] : [] };
  if (path.endsWith("/tee-signs")) return { signs: [], teeSigns: [] };
  if (path === "/admin/pdga-baselines") return pdgaOverview;
  if (path === "/admin/pdga-baselines/courses/7") return pdgaCourse;
  if (path === "/admin/pdga-baselines/validation") return pdgaValidation;
  if (path === "/admin/pdga-baselines/events" && method === "POST") return { ok: true, tournId: Number(body.tournId) };
  if (path === "/admin/pdga-baselines/ingest" && method === "POST") return { ok: true, summary: { fetches: 12, roundsStored: 4, eventsCompleted: 1, errors: [] } };
  if (path.startsWith("/admin/pdga-baselines/matches/") && method === "POST") return { ok: true };
  if (path === "/admin/course-health") return { courses: [course] };
  if (path === "/admin/course-health/7") return courseHealth;
  if (path === "/admin/course-health/7/tasks") return { tasks: [task] };
  if (path === "/admin/market/summary") return { openReports: 1 };
  if (path === "/admin/market/overview") return marketOverview;
  if (path === "/admin/lost-found/summary") return { openReports: 1 };
  if (path === "/admin/lost-found/overview") return lostFoundOverview;
  if (path === "/admin/community/reviews") return { queue: reviewPending ? [review] : [], more: false };
  if (path === "/admin/community/reviews/3" && method === "PUT") { reviewPending = false; return { ok: true }; }
  if (path === "/community/courses") return { courses: [{ ...course, difficulty: "beginner", amenities: {}, notes: "", revision: 1 }] };
  if (path === "/admin/export" && method === "POST") return { mode: "download", exportData: { exportedAt: date, counts: { events: 3 } } };
  if (path === "/admin/export/endpoints") return { destinations: [{ id: 1, name: "Club archive", url: "https://archive.invalid/upload", is_active: true }] };
  if (path === "/admin/bag-tags/challenges/41/cancel" && method === "POST") { leagueChallengeOpen = false; return { ok: true }; }
  if (path === "/admin/bag-tags/leagues/4/link" && method === "POST") return { ok: true };
  if (path === "/admin/bag-tags") return { leagues: [{
    league: { id: 4, name: "Sunday Baggers" },
    holders: [
      { tagNumber: 1, name: "Michael Fazzini", memberId: "m_mf", linked: true },
      { tagNumber: 2, name: "Pat Guest", linked: false },
      { tagNumber: 5, name: "Jordan Reyes", memberId: "m_jordan", linked: true },
      { tagNumber: 9, name: "Taylor Morgan", memberId: "m_taylor", linked: true },
    ],
    challenges: leagueChallengeOpen ? [{ id: 41, leagueId: 4, challengerName: "Taylor Morgan", challengerTag: 9, challengerScore: 51,
      defenderName: "Jordan Reyes", defenderTag: 5, defenderScore: 53, status: "pending" }] : [],
    closed: [{ id: 40, leagueId: 4, challengerName: "Avery Brooks", challengerTag: 7, challengerScore: 50, defenderName: "Michael Fazzini",
      defenderTag: 1, defenderScore: 52, status: "expired", closedNote: "expired: ladder refreshed from UDisc" }],
    unlinked: ["Pat Guest"], moves: [],
  }], series: { id: 1, name: "Club bag tags", season: "2026" }, requests: [{ id: 1, memberId: "m_avery", name: "Avery Brooks" }], challenges: [], holders: [] };
  if (path === "/leagues") return { leagues: [{ id: 1, name: "Wednesday Doubles", season: "2026" }] };
  if (path === "/fundraisers") return { fundraisers: fixtureMode === "empty" ? [] : [{ id: 1, title: "Course bench fund", status: "active" }] };
  if (path === "/meetings") return { meetings: fixtureMode === "empty" ? [] : [{ id: 1, title: "November minutes", date }] };
  return { ok: true };
}

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const viteCache = join(tmpdir(), "gvdg-admin-visual-qa-" + process.pid);
const vite = await createServer({
  // Per-run cache: Vite rewrites deps on start, so a shared dir let overlapping runs clobber each other.
  configFile: false, cacheDir: viteCache,
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { entries: ["src/admin-app/main.js"] },
  plugins: [{ name: "admin-polish-fixture", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://localhost");
      if (fontDir && url.pathname === "/qa-archivo.woff2") {
        res.setHeader("Content-Type", "font/woff2");
        res.end(await readFile(join(fontDir, "archivo.woff2")));
      } else if (url.pathname === "/admin-preview.html") {
        const html = (await readFile("admin.html", "utf8")).replace(/<link[^>]+https:[^>]+>/g, "")
          .replace('data-auth-base=""', 'data-auth-base="' + "http://" + req.headers.host + '/admin-fixture"')
          .replace(/src="admin-app\/[^"]+"/, 'src="/src/admin-app/main.js"')
          .replace("</head>", fontDir ? '<style>@font-face{font-family:Archivo;src:url(/qa-archivo.woff2) format("woff2");font-style:normal;font-weight:100 900;font-display:swap}</style></head>' : "</head>");
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, html));
      } else if (url.pathname.startsWith("/admin-fixture/")) {
        const path = url.pathname.slice("/admin-fixture".length);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        requested.push({ path, method: req.method, body });
        res.setHeader("Content-Type", "application/json");
        if (fixtureMode === "loading" && path === "/events") await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (fixtureMode === "error" && ["/events", "/admin/orders"].includes(path)) {
          res.writeHead(503);
          res.end("{}");
        } else res.end(JSON.stringify(fixture(path, req.method, url.searchParams, req.headers.authorization, body)));
      } else next();
    });
  }}],
});

await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});

const variants = [
  { name: "390", width: 390, height: 844, dark: false },
  { name: "320-large-dark", width: 320, height: 780, dark: true, large: true },
  { name: "1280", width: 1280, height: 920, dark: false },
];

async function newPage(variant, who = token) {
  const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height },
    isMobile: variant.width < 500, hasTouch: variant.width < 500, deviceScaleFactor: 1,
    permissions: ["clipboard-read", "clipboard-write"], serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  // 30s like the other heavy suites: the 1280 pass runs a long route sequence and 12s left no headroom
  // under load (the UI was correct, just late).
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("unique") && message.text().includes("key")) warnings.push(message.text());
  });
  await page.routeWebSocket("**/admin-fixture/**", (socket) => { socket.onMessage(() => {}); });
  await page.addInitScript(({ who, dark, large }) => {
    if (who) localStorage.setItem("gvdg_member_token", who);
    localStorage.setItem("theme", dark ? "dark" : "light");
    if (large) window.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "125%"; });
  }, { who, dark: variant.dark, large: variant.large });
  return { page, context };
}

function contextFor(item) {
  if (item.context === "course") return { courseId: 7, ...(item.key === "tee-signs" ? { filter: "candidate" } : {}) };
  if (item.context === "event") return { eventId: item.key === "results" ? 40 : 42 };
  return {};
}

// After every navigation the app moves focus to the new heading one animation frame later (for screen
// readers). Let that land before typing, or it can steal focus between a fill and its Enter.
async function focusSettled(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function route(page, key) {
  const item = ADMIN_DESTINATIONS.find((entry) => entry.key === key);
  const hash = appHref("admin", key, contextFor(item));
  await page.evaluate((value) => { location.hash = value; }, hash);
  await page.getByRole("heading", { name: item.label, level: 1, exact: true }).waitFor();
  await focusSettled(page);
  const pane = page.locator("#apane-" + (item.pane || key));
  await (key === "check-in" ? page : pane).locator(probes[key]).first().waitFor();
  return pane;
}

async function fit(page, label) {
  const over = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    focused: document.activeElement?.tagName,
  }));
  assert.ok(over.page <= over.width + 1, label + " overflows viewport: " + JSON.stringify(over));
  // No label may be cut off or spill out of its button (a spill widens the page on real data).
  const labels = await page.evaluate(() => [...document.querySelectorAll("button, a, [role=button], summary")].filter((node) => {
    const box = node.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2 || node.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
    if (node.scrollWidth <= node.clientWidth + 1) return false;
    const style = getComputedStyle(node);
    return !(style.overflowX !== "visible" && style.textOverflow === "ellipsis" && !/flex|grid/.test(style.display));
  }).map((node) => (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) + " (" + node.scrollWidth + ">" + node.clientWidth + ")"));
  assert.deepEqual(labels, [], label + " has clipped or spilling labels");
}

async function shot(page, name) {
  if (photos) await page.screenshot({ path: join(photos, name + ".png"), animations: "disabled", timeout: 20_000 });
}

async function verifyRoutes(variant) {
  const { page, context } = await newPage(variant);
  orderStatus = "submitted";
  reviewPending = true;
  checkedIn = false;
  liveRounds = freshLiveRounds();
  try {
    await page.goto(origin + "/admin-preview.html#today", { waitUntil: "commit", timeout: 60_000 });
    await page.getByRole("heading", { name: "Today", level: 1 }).waitFor({ timeout: 60_000 });
    const finderBox = page.locator(".app-tool-finder").first();
    if (await finderBox.isVisible()) {
      const field = await finderBox.locator("input").boundingBox();
      assert.ok(field.height >= 43.5 && field.height <= 56, variant.name + " Find a tool is one normal search field: " + field.height);
      assert.equal(await finderBox.locator("input").getAttribute("placeholder"), "Find a tool");
      await shot(finderBox, "admin-finder-" + variant.name);
    }
    for (const item of ADMIN_DESTINATIONS) {
      try {
        const activePane = await route(page, item.key);
        if (item.key === "scoring" || item.key === "results") {
          const score = activePane.getByRole("spinbutton", { name: /Taylor Morgan · Hole \d+/ }).filter({ visible: true }).first();
          await score.waitFor();
          assert.equal(await score.isEditable(), item.key === "scoring");
        }
        await fit(page, variant.name + " " + item.key);
        if (variant.name === "390" || ["today", "check-in", "scoring", "layouts", "more"].includes(item.key)) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await shot(page, item.key + "-" + variant.name);
        }
      } catch (error) {
        await shot(page, "failure-" + item.key + "-" + variant.name);
        throw new Error(variant.name + " route " + item.key, { cause: error });
      }
    }

    // Live casual rounds: every open round by code; a quiet one is marked, and an admin ends it after a confirm.
    let pane = await route(page, "scoring");
    const liveList = pane.locator("[data-admin-live-rounds='ready']");
    await liveList.getByRole("heading", { name: "Live casual rounds (2)" }).waitFor();
    const ghost = liveList.locator("[data-admin-live-round='GHOST1']");
    await ghost.getByText("Quiet over 1 hour").waitFor();
    await ghost.getByText("2 of 18 holes scored · last activity 26 h ago").waitFor();
    assert.equal(await liveList.locator("[data-admin-live-round='FRESH2']").getByText("Quiet over 1 hour").count(), 0);
    assert.equal(await ghost.getByRole("link", { name: "Watch" }).getAttribute("href"), "score.html?round=GHOST1&watch=1");
    await ghost.scrollIntoViewIfNeeded();
    await shot(liveList, "live-rounds-" + variant.name);
    await ghost.getByRole("button", { name: "End round" }).click();
    const endDialog = page.getByRole("dialog", { name: "End round GHOST1?" });
    await endDialog.waitFor();
    await endDialog.getByRole("button", { name: "End round" }).click();
    await ghost.waitFor({ state: "detached" });
    await liveList.getByRole("heading", { name: "Live casual rounds (1)" }).waitFor();

    pane = await route(page, "events");
    await pane.getByRole("button", { name: "More actions for River Park Open" }).click();
    await pane.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete event" });
    await dialog.waitFor();
    await fit(page, variant.name + " confirmation");
    await shot(page, "event-confirm-" + variant.name);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    pane = await route(page, "import");
    await pane.locator("#csvImportText").fill("name,date,type,format\nPreview Spring Open,2099-04-01,tournament,stroke");
    await pane.getByRole("button", { name: "Preview CSV" }).click();
    await pane.getByText(/Preview Spring Open/).waitFor();
    await fit(page, variant.name + " import candidates");

    await route(page, "check-in");
    const checkIn = page.getByRole("region", { name: "Selected event" });
    const checkInSaved = page.waitForResponse((response) => response.url().endsWith("/registrations/5") && response.request().method() === "PATCH");
    await checkIn.getByRole("button", { name: /Jordan Reyes/ }).click();
    assert.equal((await checkInSaved).status(), 200);
    await checkIn.getByText("Here", { exact: true }).waitFor();

    pane = await route(page, "registration");
    const fees = pane.getByLabel("Entry fee ($)", { exact: true });
    await fees.fill("30");
    const saved = page.waitForResponse((response) => response.url().endsWith("/config") && response.request().method() === "PUT");
    await pane.getByRole("button", { name: "Save settings" }).click();
    assert.equal((await saved).status(), 200);
    assert.ok(requested.some((call) => call.path === "/admin/events/42/config" && call.body?.entry_fee_cents === 3000));
    await shot(page, "registration-fees-" + variant.name);

    pane = await route(page, "members");
    await pane.getByText("Add a member", { exact: true }).click();
    const memberForm = pane.locator("#adminMemberForm");
    await memberForm.getByLabel("Name", { exact: true }).fill("New QA Member");
    await memberForm.getByLabel("PDGA #", { exact: true }).fill("123123");
    await memberForm.getByRole("button", { name: "Create & issue temp PIN" }).click();
    const pin = page.getByRole("dialog", { name: "Temporary PIN for New QA Member" });
    await pin.getByText("6831", { exact: true }).waitFor();
    await shot(page, "temporary-pin-" + variant.name);
    await pin.getByRole("button", { name: "Copy PIN" }).click();
    await pin.getByRole("button", { name: "Copied" }).waitFor();
    await pin.getByRole("button", { name: "Done" }).click();

    pane = await route(page, "layouts");
    const table = pane.getByRole("region", { name: "Layout hole table" });
    await table.focus();
    assert.ok(await table.evaluate((node) => node.clientWidth <= document.documentElement.clientWidth));
    if (variant.width < 500) {
      assert.ok(await table.evaluate((node) => node.scrollWidth > node.clientWidth), "Layout table should scroll independently");
      await table.evaluate((node) => { node.scrollLeft = 100; });
      assert.ok(await table.evaluate((node) => node.scrollLeft > 0));
    }

    pane = await route(page, "course-health");
    await pane.getByText("New task", { exact: true }).click();
    const taskForm = pane.getByRole("form", { name: "New maintenance task" });
    await taskForm.waitFor();
    await taskForm.getByRole("textbox", { name: "Title" }).fill("Replace bridge board");
    await fit(page, variant.name + " maintenance form");
    await shot(page, "maintenance-form-" + variant.name);
    const taskSaved = page.waitForResponse((response) => response.url().endsWith("/tasks") && response.request().method() === "POST");
    await taskForm.getByRole("button", { name: "Add task" }).click();
    assert.equal((await taskSaved).status(), 200);
    await pane.getByText("Task added.", { exact: true }).waitFor();

    // PDGA layout baselines: the course's matched rounds with provenance, then the club-wide tools.
    const pdgaCourse = pane.locator("[data-admin-pdga-course='ready']");
    await pdgaCourse.locator("summary", { hasText: /Blue tees · SSA\s49\.6/ }).click();
    await pdgaCourse.getByText(/Median of the 6 most recent PDGA rounds \(2023–2026\), no-wind SSA 49\.6; 1 round has no wind data/).waitFor();
    await pdgaCourse.getByText(/gust 23\.9 mph/).waitFor();
    await pdgaCourse.getByText(/no wind data · official ratings/).waitFor();
    await pdgaCourse.getByText("No PDGA rounds: Short tees").waitFor();
    const pdgaTools = pane.locator("[data-admin-pdga-tools]");
    await pdgaTools.locator("[data-admin-pdga-validation='ready']").getByText("14.2 pts", { exact: true }).waitFor();
    // The four counts: 2×2 on phones, one row on wide screens; each label stays inside its tile.
    const tiles = await pdgaTools.locator(".pdga-stat-grid > div").evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const label = node.querySelector("dt");
      return { top: Math.round(box.top), left: Math.round(box.left), spill: label.scrollWidth > label.clientWidth + 1 || box.right > document.documentElement.clientWidth };
    }));
    assert.equal(tiles.length, 4);
    assert.deepEqual(tiles.filter((tile) => tile.spill), [], variant.name + " PDGA stat labels fit their tiles");
    if (variant.width < 720) {
      assert.ok(tiles[0].top === tiles[1].top && tiles[2].top === tiles[3].top && tiles[2].top > tiles[0].top && tiles[0].left === tiles[2].left,
        variant.name + " PDGA stats are 2×2: " + JSON.stringify(tiles));
    } else assert.ok(tiles.every((tile) => tile.top === tiles[0].top), variant.name + " PDGA stats share one row");
    await pdgaTools.getByLabel("PDGA event number").fill("104547");
    const pdgaAdded = page.waitForResponse((response) => response.url().endsWith("/admin/pdga-baselines/events") && response.request().method() === "POST");
    await pdgaTools.getByRole("button", { name: "Add PDGA event" }).click();
    assert.equal((await pdgaAdded).status(), 200);
    assert.ok(requested.some((call) => call.path === "/admin/pdga-baselines/events" && call.body?.tournId === "104547"));
    await pdgaTools.getByText(/PDGA event 104547 added/).waitFor();
    const pdgaRead = page.waitForResponse((response) => response.url().endsWith("/admin/pdga-baselines/ingest") && response.request().method() === "POST");
    await pdgaTools.getByRole("button", { name: "Read PDGA events now" }).click();
    assert.equal((await pdgaRead).status(), 200);
    await pdgaTools.getByText(/12 PDGA requests, 4 rounds stored, 1 event finished\./).waitFor();
    const review = pdgaTools.locator("[data-admin-pdga-review='761495']");
    await review.locator("summary").click();
    await review.getByLabel(/Our layout for/).selectOption("9");
    const pdgaMatched = page.waitForResponse((response) => response.url().endsWith("/admin/pdga-baselines/matches/761495"));
    await review.getByRole("button", { name: "Use this layout" }).click();
    assert.equal((await pdgaMatched).status(), 200);
    assert.ok(requested.some((call) => call.path === "/admin/pdga-baselines/matches/761495" && call.body?.action === "assign" && call.body?.layoutId === 9));
    await pdgaTools.getByText("PDGA layout matched.", { exact: true }).waitFor();
    await pdgaTools.locator("details", { hasText: "Event queue" }).locator("summary").click();
    await pdgaTools.locator("[data-admin-pdga-validation='ready']").waitFor();
    await fit(page, variant.name + " PDGA baselines");
    if (photos) {
      // Element shots of tall sections: hide fixed/sticky chrome (header, dock, toasts) only while capturing.
      const hidden = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((node) =>
        /fixed|sticky/.test(getComputedStyle(node).position)).map((node, index) => {
        node.setAttribute("data-qa-hidden-chrome", String(index));
        node.style.setProperty("visibility", "hidden", "important");
        return index;
      }).length);
      await pdgaCourse.screenshot({ path: join(photos, "pdga-course-" + variant.name + ".png"), animations: "disabled", timeout: 20_000 });
      await pdgaTools.screenshot({ path: join(photos, "pdga-tools-" + variant.name + ".png"), animations: "disabled", timeout: 20_000 });
      if (hidden) await page.evaluate(() => document.querySelectorAll("[data-qa-hidden-chrome]").forEach((node) => {
        node.style.removeProperty("visibility");
        node.removeAttribute("data-qa-hidden-chrome");
      }));
    }

    pane = await route(page, "tee-signs");
    await pane.getByRole("button", { name: "Reject", exact: true }).click();
    await page.getByRole("dialog", { name: "Reject tee sign" }).getByRole("button", { name: "Cancel" }).click();

    pane = await route(page, "review-queue");
    await pane.getByRole("button", { name: "Publish review" }).click();
    await pane.getByText("No reviews waiting.").waitFor();
    assert.ok(requested.some((call) => call.path === "/admin/community/reviews/3" && call.body?.action === "approve"));

    pane = await route(page, "orders");
    const orderCard = pane.locator("[data-admin-order-id='6']");
    await orderCard.getByLabel("Status", { exact: true }).selectOption("ready");
    const orderSaved = page.waitForResponse((response) => response.url().endsWith("/admin/orders/6") && response.request().method() === "PATCH");
    await orderCard.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal((await orderSaved).status(), 200);

    pane = await route(page, "wallets");
    await pane.getByLabel("Member", { exact: true }).fill("234567");
    await pane.getByLabel("Adjustment ($)").fill("5");
    const walletSaved = page.waitForResponse((response) => response.url().endsWith("/admin/wallets/credit"));
    await pane.getByRole("button", { name: "Post wallet adjustment" }).click();
    assert.equal((await walletSaved).status(), 200);
    assert.ok(requested.some((call) => call.path === "/admin/wallets/credit" && call.body?.amount_cents === 500));

    pane = await route(page, "data-archive");
    const exported = page.waitForResponse((response) => response.url().endsWith("/admin/export") && response.request().method() === "POST");
    await pane.getByRole("button", { name: "Run export", exact: true }).click();
    assert.equal((await exported).status(), 200);
    await pane.getByText(/Download ready/).waitFor();
    await fit(page, variant.name + " archive result");
    await shot(page, "archive-export-" + variant.name);

    await route(page, "today");
    const nav = page.getByRole("navigation", { name: "Admin navigation" }).filter({ visible: true });
    await page.locator(".admin-today-feature").getByRole("button", { name: "Live scoring" }).click();
    await page.locator("#apane-scoring [data-react-admin-scoring-live='live']").waitFor();
    assert.match(new URL(page.url()).hash, /#scoring\?event=42/);
    await nav.getByRole("button", { name: "Tools", exact: true }).click();
    const tools = page.locator("#apane-more");
    await tools.getByText("Light or dark mode").waitFor();
    await focusSettled(page);
    const finder = page.getByRole("searchbox", { name: "Find a tool" });
    await finder.fill("course health");
    await finder.press("Enter");
    await page.getByRole("heading", { name: "Course health", level: 1 }).waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: "Tools", level: 1 }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme") === "dark", variant.dark);
    await tools.getByRole("button", { name: variant.dark ? "Switch to light mode" : "Switch to dark mode" }).click();
    await page.waitForFunction((dark) => (document.documentElement.getAttribute("data-theme") === "dark") === dark, !variant.dark);
    await page.getByRole("navigation", { name: "Admin header" }).getByRole("link", { name: "Help" }).click();
    const help = page.getByRole("dialog", { name: "Crotts assistant" });
    await help.waitFor();
    await fit(page, variant.name + " Help");
    await help.getByRole("button", { name: "Close Crotts assistant" }).click();
    console.log(variant.name + " verified " + ADMIN_DESTINATIONS.length + " destinations, route interactions and contained scrolling");
  } catch (error) {
    // Leave evidence for intermittent failures: what the page showed, where focus was, and the route.
    const evidence = (process.env.GVDG_ADMIN_SCREENSHOTS || tmpdir()) + "/admin-failure-" + variant.name + ".png";
    await page.screenshot({ path: evidence, fullPage: true }).catch(() => {});
    const state = await page.evaluate(() => ({ hash: location.hash, focus: document.activeElement?.outerHTML.slice(0, 160),
      h1: [...document.querySelectorAll("h1")].map((node) => node.textContent) })).catch(() => ({}));
    console.error("admin " + variant.name + " failed; screenshot " + evidence + " state " + JSON.stringify(state));
    throw error;
  } finally { await context.close(); }
}

async function verifyLeagueBagTags() {
  for (const variant of [variants[2], variants[0]]) {
    leagueChallengeOpen = true;
    const { page, context } = await newPage(variant);
    await page.goto(origin + "/admin-preview.html#today", { waitUntil: "commit", timeout: 60_000 });
    await page.getByRole("heading", { name: "Today", level: 1, exact: true }).waitFor();
    const pane = await route(page, "bag-tags");
    const section = pane.locator("[data-admin-bag-league='4']");
    await section.getByRole("heading", { name: "Sunday Baggers (UDisc league)" }).waitFor();
    await section.getByText("Taylor Morgan #9 (51) called out Jordan Reyes #5 (53)").waitFor();
    await section.getByText(/expired: ladder refreshed from UDisc/).waitFor();
    assert.equal(await section.getByRole("button", { name: "Confirm" }).count(), 0, "admin cannot confirm a league challenge");
    await pane.getByLabel("Filter by series").selectOption("club");
    assert.equal(await pane.locator("[data-admin-bag-league]").count(), 0);
    await pane.getByLabel("Filter by series").selectOption("league-4");
    await fit(page, variant.name + " league bag tags");
    if (photos) await page.screenshot({ path: join(photos, "bag-tags-league-" + variant.name + ".png"), fullPage: true, animations: "disabled", timeout: 20_000 });
    const cancelled = page.waitForResponse((response) => response.url().endsWith("/admin/bag-tags/challenges/41/cancel"));
    await section.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await cancelled).status(), 200);
    await section.getByText("No open challenges.").waitFor();
    await context.close();
  }
  console.log("League bag tag challenges verified in admin (filter, cancel, no admin confirm)");
}

try {
  for (const variant of variants) await verifyRoutes(variant);
  await verifyLeagueBagTags();
  for (const mode of ["error", "empty", "loading"]) {
    fixtureMode = mode;
    const { page, context } = await newPage(variants[0]);
    await page.goto(origin + "/admin-preview.html#events", { waitUntil: "commit", timeout: 60_000 });
    const marker = page.locator('[data-react-admin-events-list="' + mode + '"]');
    await marker.waitFor();
    await fit(page, "Events " + mode);
    await shot(page, "events-" + mode + "-390");
    await context.close();
  }
  fixtureMode = "";
  for (const [who, name] of [["qa-member", "non-admin"], ["", "signed-out"]]) {
    const { page, context } = await newPage(variants[0], who);
    await page.goto(origin + "/admin-preview.html#orders", { waitUntil: "commit", timeout: 60_000 });
    await page.locator('[data-react-admin-auth-gate="gate"]').waitFor();
    assert.equal(await page.getByRole("searchbox", { name: "Find a tool" }).count(), 0);
    assert.equal(await page.locator("body").getAttribute("data-admin-panel"), "hidden");
    await shot(page, "gate-" + name + "-390");
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter((warning) => !warning.includes("CrottsWidget")), [], "Admin renders without missing React keys");
} finally {
  await browser.close();
  await vite.close();
  await rm(viteCache, { recursive: true, force: true });
}
