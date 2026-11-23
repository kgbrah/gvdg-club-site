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
  sheets: "[data-admin-sheet-import]",
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
  donations: "[data-admin-donations='ready']",
  "lost-found": "[data-admin-lost-found='ready'] [data-admin-lf-report]",
};
assert.deepEqual(Object.keys(probes).sort(), ADMIN_DESTINATIONS.map((item) => item.key).sort());

const requested = [];
let fixtureMode = "";
let orderStatus = "submitted";
let checkedIn = false;
let leagueChallengeOpen = true;
let reviewPending = true;
// A donation a member reported (owner: "Let's make ALL donations reward +10 karma per dollar"; an admin confirms).
let donationPending = true;
let productRequests = [];
const donation = { id: 4, memberId: "m_jordan", memberName: "Jordan Reyes", amountCents: 1000, source: "club-card", status: "pending", karma: 0, createdAt: date + " 15:20:00", reviewedAt: null, reviewNote: "" };
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
  // Tiers: a lapsed member (move to Guest), a guest, and a held account from the club's sheets (link to a member).
  if (path === "/admin/members") return { members: [...people.map((person) => ({ ...person, tier: person.isAdmin ? "admin" : "member", memberThroughYear: 2026, membershipCurrent: true })),
    { memberId: "m_casey", name: "Casey Lapsed", pdgaNo: "456789", tier: "member", memberThroughYear: 2025, membershipCurrent: false, renewalYear: 2026 },
    { memberId: "m_drew", name: "Drew Visitor", udisc: "drewv", tier: "guest", memberThroughYear: 2026, membershipCurrent: false, renewalYear: null },
    { memberId: "m_h_nsamlee", name: "Sam Lee", tier: "member", held: true, memberThroughYear: 2026, membershipCurrent: true }] };
  if (path === "/me/messages/summary") return { unread: 3, unseen: 1 };
  if (path === "/admin/members/clear-locks") return { cleared: 2, member: { memberId: body.memberId } };
  if (path === "/admin/members/set-tier" || path === "/admin/members/link-held") return { member: { memberId: body.memberId || body.heldId }, carriedOver: path.endsWith("link-held") ? "Matched Sam Lee from the club's sheets: $12.50 store credit came over." : undefined };
  if (path === "/admin/members/lapsed-to-guest") return { moved: 1 };
  // The club's Google Sheets: Jordan matches by name (a change), Sam is new, "Avery Brooke" is new with a suggestion.
  if (path === "/admin/sheet-import/plan") {
    const rows = (body.rows || []).map((row) => row.name === "Jordan Reyes"
      ? { line: row.line, name: row.name, match: { memberId: "m_jordan", name: "Jordan Reyes", how: "name", held: false, tier: "member" }, action: "update", before: "$5.00", after: "$20.00", notes: [], suggestions: [] }
      : { line: row.line, name: row.name, match: null, action: "new", before: "", after: "$" + (row.value / 100).toFixed(2), notes: ["New member account, held until they sign up."],
        suggestions: row.name === "Avery Brooke" ? [{ memberId: "m_avery", name: "Avery Brooks" }] : [] });
    return { kind: body.kind, rows, releases: [], counts: { update: 1, new: rows.length - 1, same: 0, skip: 0 } };
  }
  if (path === "/admin/sheet-import/apply") return { results: (body.rows || []).map((row) => ({ line: row.line, memberId: row.memberId || "m_h_new", status: "done" })) };
  if (path === "/admin/members/applications") return { applications: [application] };
  if (path === "/admin/orders") return { unfulfilled: 1, orders: !query.get("status") || query.get("status") === orderStatus ? [{ ...order, status: orderStatus }] : [] };
  if (path === "/admin/orders/6" && method === "PATCH") { orderStatus = body.status; return { ok: true }; }
  if (path === "/admin/shop/read-label" && method === "POST") {
    return { fields: { name: "Destroyer", brand: "Innova", color: "Blue", weight: "173", productType: "distance_driver" } };
  }
  if (path === "/admin/shop/products" && method === "POST") {
    productRequests.push(body);
    return { ok: true, id: 99 };
  }
  if (path === "/admin/shop/products") return { products: [{ id: 13, name: "River fairway driver", category: "disc", price_cents: 1800, stock: 9, active: 1, description: "A straight fairway driver." }] };
  if (path === "/admin/wallets/recent") return { transactions: [
    { id: 4, member_id: "m_jordan", member_name: "Jordan Reyes", amount_cents: 1250, source: "manual_adjustment", note: "Club payout", created_by: "m_casey", created_at: date },
    { id: 3, member_id: "m_casey", member_name: "Casey Lin", amount_cents: 500, source: "event_payout", event_id: 4, event_name: "Putt League", note: "Event payout: Putt League", created_at: "2026-11-14 00:45:02" },
  ] };
  if (path === "/admin/wallets/m_jordan") return { balance_cents: 3000, more: false, transactions: [
    { id: 4, amount_cents: 1250, transaction_type: "credit", source: "manual_adjustment", note: "Club payout", created_by: "m_casey", created_at: "2026-11-18 15:00:00" },
    { id: 2, amount_cents: 1750, transaction_type: "credit", source: "sheet_import", note: null, created_by: "m_casey", created_at: "2026-09-01 10:00:00" },
  ] };
  if (path === "/admin/wallets/credit") return { balance_cents: 1750 };
  if (path === "/admin/wallets/m_casey") {
    const all = [
      { id: 12, amount_cents: -500, transaction_type: "debit", source: "event_entry", event_id: 4, event_name: "Fall Classic", note: null, created_by: null, created_at: "2026-11-01 10:00:00" },
      { id: 8, amount_cents: 1000, transaction_type: "credit", source: "manual_adjustment", note: "League payout", created_by: "m_jordan", created_at: "2026-10-20 10:00:00" },
      { id: 3, amount_cents: 750, transaction_type: "credit", source: "sheet_import", note: "Balance from the club's Google Sheet", created_by: "m_jordan", created_at: "2026-09-01 10:00:00" },
    ];
    const older = query.get("before");
    return older ? { balance_cents: 1250, transactions: all.slice(2), more: false } : { balance_cents: 1250, transactions: all.slice(0, 2), more: true };
  }
  if (path === "/admin/wallets/balances") return { totalCents: 4250, withBalance: 2, members: [
    { memberId: "m_jordan", name: "Jordan Reyes", pdgaNo: "234567", balanceCents: 3000, transactions: 3, lastActivityAt: "2026-11-10 10:00:00", onRoster: true },
    { memberId: "m_casey", name: "Casey Lin", pdgaNo: null, balanceCents: 1250, transactions: 1, lastActivityAt: "2026-11-01 10:00:00", onRoster: true },
    { memberId: "m_ada", name: "Ada Park", pdgaNo: null, balanceCents: 0, transactions: 0, lastActivityAt: null, onRoster: true },
  ] };
  if (path === "/admin/tee-signs") return { teeSigns: query.get("status") === "candidate" ? [tee] : [] };
  if (path.endsWith("/tee-signs")) return { signs: [], teeSigns: [] };
  if (path === "/admin/course-health") return { courses: [course] };
  if (path === "/admin/course-health/7") return courseHealth;
  if (path === "/admin/course-health/7/tasks") return { tasks: [task] };
  if (path === "/admin/market/summary") return { openReports: 1 };
  if (path === "/admin/market/overview") return marketOverview;
  if (path === "/admin/lost-found/summary") return { openReports: 1 };
  if (path === "/admin/donations") return { pending: donationPending ? [donation] : [], recent: donationPending ? [] : [{ ...donation, status: "confirmed", karma: 100, reviewedAt: date + " 16:00:00" }], karmaPerDollar: 10 };
  if (path === "/admin/donations/4/review" && method === "POST") { donationPending = false; return { donation: { ...donation, status: "confirmed", karma: 100 } }; }
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

/**
 * Text the theme forgot: any visible text whose colour against what's behind it is under 3:1 (owner, with a screenshot
 * of dark text on a dark card in Today's "Up next": "Got some theme unaware text in admin section"). Text over a
 * photo or gradient is skipped (its background can't be read), as is text faded on purpose (opacity under .6).
 */
async function readable(page, label) {
  const low = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const cache = new Map();
    const rgba = (css) => {
      if (!cache.has(css)) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        cache.set(css, { r, g, b, a: a / 255 });
      }
      return cache.get(css);
    };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    function background(el) {
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage && style.backgroundImage !== "none") return null;
        const color = rgba(style.backgroundColor);
        if (color.a > 0) { layers.push(color); if (color.a >= 0.99) break; }
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
      return base;
    }
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || seen.has(el) || !node.textContent.trim()) continue;
      seen.add(el);
      if (el.closest("script, style, [hidden], [aria-hidden='true'], [inert], option")) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > innerHeight * 4) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none") continue;
      let opacity = 1;
      for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      if (opacity < 0.6) continue;
      const bg = background(el);
      if (!bg) continue;
      const fg = over(rgba(style.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < 3) out.push(`"${node.textContent.trim().slice(0, 40)}" ${ratio.toFixed(2)}:1 (${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")} in ${el.closest("[class]") && el.closest("button, a, section, article, li, div[class]")?.className?.toString().split(" ")[0]})`);
    }
    return out;
  });
  for (const line of low) unreadable.add(label.replace(/^\S+ /, "") + " [" + label.split(" ")[0] + "]: " + line);
}
// Collected across every screen and theme, reported once at the end (so one run lists them all).
const unreadable = new Set();

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
        await readable(page, variant.name + " " + item.key);
        if (item.key === "today" && variant.dark) {
          // Today's "Up next" rows are whole buttons: their names follow the theme (the owner's dark-on-dark screenshot).
          const upNext = page.locator("button.admin-evrow").first();
          if (await upNext.count()) await shot(upNext, "today-up-next-" + variant.name);
        }
        if (variant.name === "390" || ["today", "check-in", "scoring", "layouts", "more"].includes(item.key)) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await shot(page, item.key + "-" + variant.name);
        }
      } catch (error) {
        await shot(page, "failure-" + item.key + "-" + variant.name);
        throw new Error(variant.name + " route " + item.key, { cause: error });
      }
    }

    // Donations: Today's Needs you points to Money › Donations, where Received confirms it (+10 karma a dollar).
    if (variant.name === "390") {
      donationPending = true;
      await route(page, "today");
      await page.locator(".admin-needs-row, [data-admin-needs-item], button, a").filter({ hasText: "Donation to confirm" }).first().waitFor();
      const donations = await route(page, "donations");
      const row = donations.locator("[data-admin-donation='4']");
      await row.waitFor();
      assert.ok((await row.innerText()).includes("Jordan Reyes · $10"), "who and how much");
      assert.ok((await row.innerText()).includes("+100 karma when confirmed"), "+10 karma a dollar");
      await shot(page, "donations-" + variant.name);
      await row.getByRole("button", { name: "Received", exact: true }).click();
      await donations.getByText("Jordan Reyes · $10 · received, +100 karma", { exact: false }).waitFor();
      assert.ok(requested.some((call) => call.path === "/admin/donations/4/review" && call.body?.decision === "received"));
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
    await pane.getByText(/Preview Spring Open \(2099-04-01\)/).waitFor();
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
    // The top bar's envelope and bell: the member app's counts, opening Messages there.
    const mail = page.locator("[data-admin-header='messages']");
    assert.match(await mail.getAttribute("href"), /gvdg-members\.html#messages$/);
    await mail.locator(".admin-header-badge", { hasText: "3" }).waitFor();
    assert.equal(await page.locator("[data-admin-header='notices']").getAttribute("aria-label"), "Notifications, 1 new");
    // Light/dark in the top bar (owner: "a light/dark theme control wired into top bar for admin like member site"),
    // fitting beside everything else even on the narrowest phone, and switching the whole page both ways.
    const themeButton = page.locator(".admin-app-header .theme-toggle");
    await themeButton.waitFor();
    const header = await page.locator(".admin-app-header nav").evaluate((nav) => ({ scroll: nav.scrollWidth, client: nav.clientWidth }));
    assert.ok(header.scroll <= header.client + 1, "the top bar fits with the theme button: " + JSON.stringify(header));
    // The top bar's links keep their names when they shrink to icons.
    await page.locator(".admin-app-header").getByRole("link", { name: "Help" }).waitFor();
    await page.locator(".admin-app-header").getByRole("link", { name: "Member app" }).waitFor();
    const box = await themeButton.boundingBox();
    assert.ok(box && box.width >= 36 && box.height >= 36, "a thumb-sized theme button");
    const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
    await themeButton.click();
    const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
    assert.notEqual(after, before, "the top bar's button switches light/dark");
    assert.equal(await themeButton.getAttribute("aria-pressed"), after === "dark" ? "true" : "false");
    await shot(page.locator(".admin-app-header"), "header-theme-" + after + "-" + variant.name);
    await themeButton.click();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"), before);
    await shot(page.locator(".admin-app-header"), "header-inbox-" + variant.name);
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

    // Account tiers: lapsed members to Guest in one go, a tier picker per person, and linking a held account.
    const members = pane.locator("[data-react-admin-members-list='ready']");
    await members.locator("[data-member-tier='guest']").getByText(/Drew Visitor - drewv - guest/).waitFor();
    await members.getByRole("button", { name: "Move 1 lapsed member to Guest" }).click();
    await page.getByRole("dialog", { name: "Move 1 lapsed member to Guest?" }).getByRole("button", { name: "Move to Guest" }).click();
    await members.getByRole("combobox", { name: "Tier for Jordan Reyes" }).selectOption("guest");
    await page.getByRole("dialog", { name: "Make Jordan Reyes a guest?" }).getByRole("button", { name: "Make guest" }).click();
    const heldRow = members.locator("[data-member-held='true']");
    await heldRow.getByText("Sam Lee - held: no sign-in yet - through 2026").waitFor();
    assert.equal(await heldRow.getByRole("menuitem", { name: "Reissue PIN", includeHidden: true }).count(), 0, "a held account has no sign-in to reset");
    assert.equal(await heldRow.getByRole("menuitem", { name: "Clear lockouts", includeHidden: true }).count(), 0, "a held account has no sign-in to unlock");
    // One tidy row: tier, Renew, Wallet and More; the now-and-then actions are in More.
    const jordanRow = members.locator("[data-admin-member-id='m_jordan']");
    await shot(jordanRow, "member-row-" + variant.name);
    await shot(members.locator("[data-admin-member-id='m_casey']"), "member-row-renew-" + variant.name);
    await jordanRow.locator(".admin-member-more > summary").click();
    const more = jordanRow.getByRole("menu");
    assert.deepEqual(await more.getByRole("menuitem").allTextContents(), ["Reissue PIN", "Clear lockouts", "Remove member"]);
    await jordanRow.scrollIntoViewIfNeeded();
    await shot(page, "member-row-more-" + variant.name);
    // Clear lockouts: one tap lifts wrong-PIN lockouts and "too many tries" limits.
    await more.getByRole("menuitem", { name: "Clear lockouts" }).click();
    await page.getByText("Lockouts cleared for Jordan Reyes - they can try again now").waitFor();
    assert.equal(await jordanRow.locator(".admin-member-more[open]").count(), 0, "the menu closes after a choice");
    assert.ok(requested.some((call) => call.path === "/admin/members/clear-locks" && call.body?.memberId === "m_jordan"));
    await heldRow.scrollIntoViewIfNeeded();
    await shot(heldRow, "member-held-" + variant.name);
    await heldRow.getByRole("combobox", { name: "Link Sam Lee to a member already in the app" }).selectOption("m_jordan");
    await page.getByRole("dialog", { name: "Link to Jordan Reyes?" }).getByRole("button", { name: "Link" }).click();
    await page.getByText("Matched Sam Lee from the club's sheets: $12.50 store credit came over.").waitFor();
    assert.ok(requested.some((call) => call.path === "/admin/members/lapsed-to-guest"));
    assert.ok(requested.some((call) => call.path === "/admin/members/set-tier" && call.body?.memberId === "m_jordan" && call.body?.tier === "guest"));
    assert.ok(requested.some((call) => call.path === "/admin/members/link-held" && call.body?.heldId === "m_h_nsamlee" && call.body?.memberId === "m_jordan"));

    // The club's Google Sheets (Members › Google Sheets): paste the cells, check the guessed columns, review, pick who
    // "Avery Brooke" is, apply.
    pane = await route(page, "sheets");
    assert.equal(await page.locator("#apane-import [data-admin-sheet-import]").count(), 0, "the sheets aren't under Import event any more");
    const sheet = pane.locator("[data-admin-sheet-import]");
    await sheet.getByRole("radio", { name: "Store credit balances" }).click();
    await sheet.getByLabel("Or paste the cells (select the sheet, copy, paste here)").fill("Player\tStore credit\nJordan Reyes\t$20.00\nSam Lee\t$12.50\nAvery Brooke\t$3.00\n");
    await sheet.getByRole("button", { name: "Use these cells" }).click();
    await sheet.getByText("Columns · 3 rows").waitFor();
    assert.equal(await sheet.getByLabel("Name", { exact: true }).inputValue(), "0");
    assert.equal(await sheet.getByLabel("Balance", { exact: true }).inputValue(), "1");
    await sheet.getByRole("button", { name: "Check against the app" }).click();
    await sheet.getByText("1 to change · 2 new held accounts · 0 already match").waitFor();
    await sheet.locator("[data-sheet-row='2']").getByText("Changes · Matched Jordan Reyes by name · $5.00 → $20.00").waitFor();
    await sheet.getByLabel("Who is this?").selectOption("m_avery");
    await sheet.locator("[data-sheet-plan]").scrollIntoViewIfNeeded();
    await shot(sheet, "sheet-import-review-" + variant.name);
    await fit(page, variant.name + " sheet import review");
    await sheet.getByRole("button", { name: "Apply 3 changes" }).click();
    await page.getByRole("dialog", { name: "Apply 3 changes?" }).getByRole("button", { name: "Apply" }).click();
    await sheet.getByText("Done: 3 changes from the sheet applied.").waitFor();
    const applied = requested.filter((call) => call.path === "/admin/sheet-import/apply").pop();
    assert.deepEqual(applied.body.rows.map((row) => [row.name, row.value, row.memberId]), [["Jordan Reyes", 2000, "m_jordan"], ["Sam Lee", 1250, ""], ["Avery Brooke", 300, "m_avery"]]);

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
    // Every member's balance (owner: "need admin to be able to view all member wallet balances"), with the total.
    const balances = pane.locator("[data-admin-wallet-balances='ready']");
    await balances.waitFor();
    assert.match(await balances.locator("[data-wallet-total]").innerText(), /\$42\.50 in store credit across 2 members/);
    assert.deepEqual(await balances.locator("[data-wallet-member]").evaluateAll((rows) => rows.map((row) => row.dataset.walletMember)), ["m_jordan", "m_casey"]);
    // The search autocompletes names; picking one narrows the list.
    await balances.getByLabel("Find a member's balance").fill("ca");
    await balances.locator(".ac-option", { hasText: "Casey Lin" }).waitFor();
    await shot(page, "wallet-autocomplete-" + variant.name);
    await balances.locator(".ac-option", { hasText: "Casey Lin" }).click();
    assert.equal(await balances.getByLabel("Find a member's balance").inputValue(), "Casey Lin");
    assert.deepEqual(await balances.locator("[data-wallet-member]").evaluateAll((rows) => rows.map((row) => row.dataset.walletMember)), ["m_casey"]);
    await shot(page, "wallet-balances-" + variant.name);
    // The drill-down: every transaction for that member, the balance after each, who posted it; older ones on demand.
    await balances.locator("[data-wallet-member='m_casey']").getByRole("button", { name: "Transactions" }).click();
    const ledger = balances.locator("[data-wallet-member='m_casey'] [data-wallet-ledger='ready']");
    await ledger.waitFor();
    assert.deepEqual(await ledger.locator("[data-wallet-tx]").evaluateAll((rows) => rows.map((row) => row.dataset.walletTx)), ["12", "8"]);
    assert.match(await ledger.locator("[data-wallet-tx='12']").innerText(), /Event entry: Fall Classic[\s\S]*−\$5\.00[\s\S]*balance after \$12\.50/);
    assert.match(await ledger.locator("[data-wallet-tx='8']").innerText(), /Admin adjustment[\s\S]*\+\$10\.00[\s\S]*League payout[\s\S]*balance after \$17\.50 · by Jordan Reyes/);
    await ledger.getByRole("button", { name: "Show older transactions" }).click();
    await ledger.locator("[data-wallet-tx='3']").waitFor();
    assert.match(await ledger.locator("[data-wallet-tx='3']").innerText(), /Google Sheet balance[\s\S]*\+\$7\.50[\s\S]*balance after \$7\.50/);
    assert.equal(await ledger.getByRole("button", { name: "Show older transactions" }).count(), 0);
    await shot(page, "wallet-drilldown-" + variant.name);
    // "Adjust" fills the adjustment form with that member.
    await balances.locator("[data-wallet-member='m_casey']").getByRole("button", { name: "Adjust" }).click();
    assert.equal(await pane.getByLabel("Member", { exact: true }).inputValue(), "m_casey");
    await balances.getByLabel("Find a member's balance").fill("");
    await balances.getByLabel("Show $0 balances").check();
    assert.equal(await balances.locator("[data-wallet-member]").count(), 3);
    // The form's member field autocompletes too (picking fills the member's id).
    await pane.getByLabel("Member", { exact: true }).fill("jor");
    await pane.locator("#adminWalletForm .ac-option", { hasText: "Jordan Reyes" }).click();
    assert.equal(await pane.getByLabel("Member", { exact: true }).inputValue(), "m_jordan");
    await pane.getByLabel("Member", { exact: true }).fill("234567");
    await pane.getByLabel("Adjustment ($)").fill("5");
    const walletSaved = page.waitForResponse((response) => response.url().endsWith("/admin/wallets/credit"));
    await pane.getByRole("button", { name: "Post wallet adjustment" }).click();
    await page.getByRole("dialog", { name: "Post wallet adjustment?" }).getByRole("button", { name: "Post adjustment" }).click();
    assert.equal((await walletSaved).status(), 200);
    assert.ok(requested.some((call) => call.path === "/admin/wallets/credit" && call.body?.amount_cents === 500));

    // The Recent wallet ledger reads in words, and an entry opens that member's whole wallet history beneath it
    // (owner: "Let's extend the drill down to the ledger too").
    pane = await route(page, "wallets");
    const recent = pane.locator("[data-react-admin-wallet-recent='ready']");
    await recent.waitFor();
    const payoutRow = recent.locator("[data-admin-wallet-row='1']");
    assert.match(await payoutRow.innerText(), /Casey Lin[\s\S]*\+\$5\.00[\s\S]*Event payout: Putt League/);
    assert.doesNotMatch(await recent.innerText(), /manual_adjustment|event_payout/);
    const ledgerJordanRow = recent.locator("[data-admin-wallet-row='0']");
    assert.match(await ledgerJordanRow.innerText(), /Jordan Reyes[\s\S]*Admin adjustment[\s\S]*Club payout[\s\S]*by Casey Lin/);
    await ledgerJordanRow.getByRole("button").click();
    assert.equal(await ledgerJordanRow.getByRole("button").first().getAttribute("aria-expanded"), "true");
    const history = ledgerJordanRow.locator("[data-wallet-ledger='ready']");
    await history.waitFor();
    assert.deepEqual(await history.locator("[data-wallet-tx]").evaluateAll((rows) => rows.map((row) => row.dataset.walletTx)), ["4", "2"]);
    assert.match(await history.locator("[data-wallet-tx='2']").innerText(), /Google Sheet balance[\s\S]*\+\$17\.50[\s\S]*balance after \$17\.50/);
    await shot(page, "wallet-ledger-drilldown-" + variant.name);
    await ledgerJordanRow.getByRole("button").first().click();
    assert.equal(await history.count(), 0);

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

async function verifyShopCamera() {
  productRequests = [];
  const camBrowser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", ...(process.env.GVDG_QA_NO_SANDBOX ? ["--no-sandbox"] : [])],
  });
  async function openCamPage(variant, scripts = []) {
    const context = await camBrowser.newContext({
      viewport: { width: variant.width, height: variant.height },
      isMobile: variant.width < 500,
      hasTouch: variant.width < 500,
      deviceScaleFactor: 1,
      permissions: ["camera", "clipboard-read", "clipboard-write"],
      serviceWorkers: "block",
    });
    await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("unique") && message.text().includes("key")) warnings.push(message.text());
    });
    await page.routeWebSocket("**/admin-fixture/**", (socket) => { socket.onMessage(() => {}); });
    await page.addInitScript(({ who, dark }) => {
      localStorage.setItem("gvdg_member_token", who);
      localStorage.setItem("theme", dark ? "dark" : "light");
    }, { who: token, dark: variant.dark });
    for (const script of scripts) await page.addInitScript(script);
    return { context, page };
  }
  const spyCamera = () => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    const real = media.getUserMedia.bind(media);
    window.__gvStreams = [];
    media.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      window.__gvStreams.push(stream);
      return stream;
    };
  };
  const noLiveCamera = () => {
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", { configurable: true, value: undefined });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: undefined });
  };
  const noCameraHardware = () => {
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "", groupId: "", label: "" }];
  };
  try {
    // 1. Mobile camera capture: viewfinder sits above admin-dock, snaps JPEG, auto-reads label, and submits product.
    const live = await openCamPage(variants[0], [spyCamera]);
    await live.page.goto(origin + "/admin-preview.html#shop", { waitUntil: "commit", timeout: 60_000 });
    await live.page.getByRole("heading", { name: "Inventory", level: 1, exact: true }).waitFor();
    const form = live.page.locator("#adminProductForm");
    await form.locator("[data-photo-camera='live']").waitFor();
    await form.getByRole("button", { name: "Take photo" }).waitFor();
    await form.getByRole("button", { name: "Choose photo" }).waitFor();
    await form.getByRole("button", { name: "Take photo" }).click();
    const sheet = live.page.locator(".gv-camera[data-gv-camera='ready']");
    await sheet.waitFor();
    const shutterTop = await live.page.evaluate(() => {
      const shutter = document.querySelector(".gv-camera-shutter");
      const box = shutter?.getBoundingClientRect();
      if (!box) return false;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(hit && shutter.contains(hit) && !hit.closest(".admin-dock"));
    });
    assert.equal(shutterTop, true, "camera shutter must sit above mobile admin-dock");
    await sheet.getByRole("button", { name: "Take photo", exact: true }).click();
    await sheet.locator(".gv-camera-shot").first().waitFor();
    assert.equal((await sheet.locator(".gv-camera-count").innerText()).trim(), "1 of 1");
    const doneTop = await live.page.evaluate(() => {
      const done = document.querySelector(".gv-camera-done");
      const box = done?.getBoundingClientRect();
      if (!box) return false;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(hit && done.contains(hit) && !hit.closest(".admin-dock"));
    });
    assert.equal(doneTop, true, "camera Done button must sit above mobile admin-dock");
    await sheet.getByRole("button", { name: "Use 1 photo" }).click();
    await live.page.locator(".gv-camera").waitFor({ state: "detached" });
    const tracks = await live.page.evaluate(() => (window.__gvStreams || []).flatMap((stream) => stream.getTracks()).map((track) => track.kind + ":" + track.readyState));
    assert.ok(tracks.length > 0 && tracks.every((track) => track === "video:ended"), "camera tracks stop after Done: " + tracks.join(", "));
    const preview = form.locator("[data-react-admin-product-image-preview='ready']");
    await preview.waitFor();
    assert.match(String(await preview.locator("img").getAttribute("src") || ""), /^data:image\/jpeg;base64,/);
    await preview.getByText("Filled from the photo. Change anything that's wrong.").waitFor();
    assert.equal(await form.locator("#psName").inputValue(), "Destroyer");
    assert.equal(await form.locator("#psBrand").inputValue(), "Innova");
    assert.equal(await form.locator("#psColor").inputValue(), "Blue");
    assert.equal(await form.locator("#psWeight").inputValue(), "173");
    await form.getByRole("button", { name: "Retake photo" }).waitFor();
    await fit(live.page, "390 shop-camera-preview");
    await readable(live.page, "390 shop-camera-preview");
    await shot(live.page, "shop-camera-preview-390");
    await form.locator("#psPrice").fill("18");
    const posted = live.page.waitForResponse((response) => response.url().endsWith("/admin/shop/products") && response.request().method() === "POST");
    await form.getByRole("button", { name: "Add product" }).click();
    assert.equal((await posted).status(), 200);
    assert.equal(productRequests.length, 1);
    assert.match(String(productRequests[0]?.image_url || ""), /^data:image\/jpeg;base64,/);
    await preview.waitFor({ state: "detached" });

    // Retake and Remove photo clears the uploaded photo before saving.
    await form.getByRole("button", { name: "Take photo" }).click();
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Take photo", exact: true }).click();
    await sheet.locator(".gv-camera-shot").first().waitFor();
    await sheet.getByRole("button", { name: "Use 1 photo" }).click();
    await preview.waitFor();
    await preview.getByRole("button", { name: "Remove photo" }).click();
    await preview.waitFor({ state: "detached" });
    await form.getByRole("button", { name: "Take photo" }).waitFor();
    await live.context.close();

    // 2. Phone browser without getUserMedia falls back to capture="environment" camera input.
    const appMode = await openCamPage(variants[0], [noLiveCamera]);
    await appMode.page.goto(origin + "/admin-preview.html#shop", { waitUntil: "commit", timeout: 60_000 });
    await appMode.page.getByRole("heading", { name: "Inventory", level: 1, exact: true }).waitFor();
    const appForm = appMode.page.locator("#adminProductForm");
    await appForm.locator("[data-photo-camera='app']").waitFor();
    const chooserPromise = appMode.page.waitForEvent("filechooser");
    await appForm.getByRole("button", { name: "Take photo" }).click();
    const chooser = await chooserPromise;
    assert.equal(await chooser.element().getAttribute("capture"), "environment");
    assert.equal(await chooser.element().getAttribute("data-gv-photo-input"), "camera");
    await appMode.context.close();

    // 3. Desktop without a camera hides Take photo and keeps Upload photo.
    const noCam = await openCamPage(variants[2], [noCameraHardware]);
    await noCam.page.goto(origin + "/admin-preview.html#shop", { waitUntil: "commit", timeout: 60_000 });
    await noCam.page.getByRole("heading", { name: "Inventory", level: 1, exact: true }).waitFor();
    const deskForm = noCam.page.locator("#adminProductForm");
    await deskForm.locator("[data-photo-camera='none']").waitFor();
    assert.equal(await deskForm.getByRole("button", { name: "Take photo" }).count(), 0);
    await deskForm.getByRole("button", { name: "Upload photo" }).waitFor();
    await noCam.context.close();
  } finally {
    await camBrowser.close();
  }
  console.log("Admin shop camera verified (live capture, stamp autofill, product POST, app fallback, no-camera desktop)");
}

try {
  for (const variant of variants) await verifyRoutes(variant);
  await verifyLeagueBagTags();
  await verifyShopCamera();
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
  assert.deepEqual([...unreadable], [], "Admin text the theme left unreadable (under 3:1), by screen [size/theme]");
} finally {
  await browser.close();
  await vite.close();
  await rm(viteCache, { recursive: true, force: true });
}
