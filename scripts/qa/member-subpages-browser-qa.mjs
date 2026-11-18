import { handicapKey } from "../../src/shared/handicap.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createServer } from "vite";
import { buildTheme } from "../../src/shared/dashboard-theme-model.js";
import { MEMBER_DESTINATIONS } from "../../src/shared/app-navigation.js";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";

const JORDAN_KEY = "9f54821bf08584f9";
const member = { sub: "m_qa", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: false };
const now = new Date().toISOString();
const course = { id: 7, name: "West Meadowbrook Park", location: "Greenville", difficulty: "intermediate", reviewCount: 1, averageRating: 4,
  amenities: { restrooms: "yes", accessibleParking: "yes", practiceBasket: "yes", drinkingWater: "no", stepFreeRoute: "unknown" }, updatedAt: now };
const layout = { id: 11, name: "Main", holes: [{ hole: 1, par: 3 }] };
const event = { id: 51, name: "Sunday Bag Tag Round", status: "scheduled", type: "league_round", date: "2026-12-06", course_id: 7,
  course_name: course.name, layout_name: layout.name, entry_fee_cents: 700, divisions: '["MA2","FA2"]', field: [{ name: "Jordan", division: "MA2" }] };
const alternatives = { ...event, id: 52, name: "Winter League Kickoff", status: "live" };
const score = { id: 5, round_code: "FORD19", course_name: course.name, layout_name: layout.name, layout_id: layout.id,
  finalized_at: now, total: 57, to_par: 3, place: 1, stroke: true, scorecard: '[{"hole":1,"par":3,"strokes":4}]' };
const playSchema = "gvdg-play-export-2";
const playCursor = "3:0";
const playRound = { id: "casual:5", source: "casual", playedAt: now, courseName: course.name, layoutName: layout.name,
  total: 4, holes: [{ hole: 1, par: 3, strokes: 4, marks: [{ n: 1, lat: 35.62, lng: -77.375 }] }] };
const playClip = { id: 30, scope: "round", scopeKey: "FORD19", hole: 1, mediaPath: "/rounds/FORD19/live/clips/30/media" };
const playCsvHeader = "record_type,schema_version,member_id,round_id,source,played_at,course,layout,hole,par,strokes,data_json";

function playExportPage(cursor) {
  const manifest = { schemaVersion: playSchema, memberId: member.sub, exportedAt: now };
  return { ...manifest, rounds: cursor ? [] : [playRound], clips: cursor ? [playClip] : [] };
}

function playExportCsv(archive) {
  const { rounds, clips, ...manifest } = archive;
  const record = (type, data, fields = []) => {
    const escaped = '"' + JSON.stringify(data).replaceAll('"', '""') + '"';
    return [type, manifest.schemaVersion, manifest.memberId, ...fields, ...Array(8 - fields.length).fill(""), escaped].join(",");
  };
  const rows = [record("manifest", manifest)];
  for (const round of rounds) {
    const { holes, ...summary } = round;
    const fields = [round.id, round.source, round.playedAt, round.courseName, round.layoutName];
    rows.push(record("round", summary, fields));
    for (const hole of holes) rows.push(record("hole", hole, [...fields, hole.hole, hole.par, hole.strokes]));
  }
  for (const clip of clips) rows.push(record("clip", clip));
  return [playCsvHeader, ...rows, ""].join("\r\n");
}

const profileKey = "5df897bb-c32c-4705-900c-14cb396246bc";
const friendKey = "b8c81812-738e-43d0-a231-35ee773329a1";
const profile = { key: profileKey, audience: "public", displayName: "Taylor Morgan", bio: "Weekend doubles and Rocky Ford rounds.",
  shareProgress: false, revision: 2 };
const progress = { totals: { club: 2, casual: 3 }, streak: 2, streakCapped: false, achieved: [1, 5], next: 10, weekly: [
  { startsOn: "2026-11-02", rounds: 2 }, { startsOn: "2026-11-09", rounds: 3 },
] };
const discId = "1c8381ad-2e29-42d2-a363-4fcf3176184c";
const disc = { id: discId, kind: "disc", revision: 1,
  record: { brand: "Axiom", model: "Envy", plastic: "Neutron", weightGrams: 173, notes: "", inBag: true, archived: false } };
const putt = { id: "c871cb33-5356-49b8-a8a9-af84f3a6079d", kind: "putting", revision: 1,
  record: { date: now.slice(0, 10), stations: [{ distance: 18, unit: "ft", meters: 5.486, attempts: 25, makes: 18 }] } };
const screenshotDir = process.env.GVDG_MEMBER_SURFACE_IMAGES || join(tmpdir(), "gvdg-member-subpages");
const wallpaper = "data:image/jpeg;base64," + (await readFile("img/slide4.jpg")).toString("base64");
const blue = buildTheme({ mode: "dark", wallpaper, sourcePalette: [
  "#112a57", "#b5e64e", "#88c9a3", "#e7cc9b", "#507be1", "#b190d6", "#a7caf4", "#e3eefc",
  "#415876", "#d1f29c", "#c2efcf", "#f5e0b6", "#8cb2ff", "#dbbbef", "#c3e3fe", "#f4f8ff",
] });
const fontPath = process.env.GVDG_VISUAL_FONT_PATH;
const localFont = fontPath ? await readFile(fontPath) : null;
const apiRoot = "/fixture";
const snapshots = new Map();

function seededFixture(id) {
  if (!snapshots.has(id)) snapshots.set(id, {
    favorite: false, asks: 0, themeWrites: 0, signs: [], playExportQueries: [], profile, posts: [{ id: 4, member_id: member.sub, author_name: member.name,
      created_at: "Nov 13, 2026", body: "Meet at the first tee at 9 on Sunday.", replies: [] }],
  });
  return snapshots.get(id);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}

async function serveFixture(path, query, request, ref, reply) {
  const scenario = ref.get("state") || "populated";
  const empty = scenario === "empty";
  const fixture = seededFixture(ref.get("run") || "preview");
  if (scenario === "error" && ["/courses", "/course-traffic", "/community/directory", "/community/courses", "/board", "/my-play-history"].includes(path)) {
    reply({ error: "fixture_unavailable" }, 503);
    return;
  }
  if (scenario === "loading" && ["/courses", "/community/directory", "/community/courses", "/board", "/my-play-history"].includes(path)) {
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (path === "/me") reply({ ...member, mustChangePin: request.headers.authorization === "Bearer temporary" });
  else if (path === "/login") {
    const { identifier } = await readBody(request);
    if (identifier === "bad") reply({ error: "invalid_credentials" }, 401);
    else reply({ ...member, token: "temporary", mustChangePin: true });
  }
  else if (path === "/set-pin") reply({ token: "member-token", name: member.name });
  else if (path === "/membership/apply") reply({ ok: true }, 201);
  else if (path === "/me/dashboard-theme") {
    if (request.method !== "GET") fixture.themeWrites += 1;
    reply({ theme: ref.get("mode") === "blue" ? blue : null });
  }
  else if (path === "/pdga-stats") reply({ name: member.name, official_rating: 905, live_rating: 918, events: [] });
  // Karma next to names: the signed-in member (board posts) and Jordan Parker (PDGA "going").
  else if (path === "/karma") reply({ players: empty ? {} : { [handicapKey(member.sub)]: 30, [JORDAN_KEY]: 40 }, traders: {} });
  else if (path === "/pdga-registrations") reply(empty ? { mine: [], club: [] } : {
    mine: [{ eventId: 501, name: "Greenville Winter Classic Presented by the Pitt County Disc Golf Association", tier: "B",
      location: "Greenville, North Carolina", start: "2026-12-12", end: "2026-12-13", url: "https://www.pdga.com/tour/event/501",
      checkedAt: "2026-11-18 15:00:00", division: "MA2", going: [{ name: "Jordan Parker", division: "MA3", karmaKey: JORDAN_KEY }, { name: "Sam Rivera", division: "MPO" }] }],
    club: [{ eventId: 502, name: "Raleigh Doubles", tier: "C", location: "Raleigh, North Carolina", start: "2027-01-09", end: "2027-01-09",
      url: "https://www.pdga.com/tour/event/502", checkedAt: null, going: [{ name: "Jordan Parker", division: "MA3" }] }],
  });
  else if (path === "/pdga-events") reply({ events: empty ? [] : [{ name: "Pitt County Winter Open", date: "Dec 13, 2026",
    location: "Greenville", tier: "C", miles: 7.2, course: course.name, url: "https://www.pdga.com/tour/event/12345" }] });
  else if (path === "/my-results") reply({ results: [], casual: empty ? [] : [score] });
  else if (path === "/my-ratings") reply({ competitive: { rounds: [] }, casual: { rounds: [] } });
  else if (path === "/my-live-rounds") reply({ rounds: [] });
  else if (path === "/rounds/RIVER7/live/mine") reply({ status: "live", cardId: 1, cardmates: [{ name: member.name }] });
  else if (path === "/my-play-history") reply({
    options: { courses: [{ key: "id:7", label: course.name }], layouts: [{ key: "id:11", label: layout.name }], holes: [1] },
    filters: { source: "all", group: "singles", style: "stroke", course: "", layout: "" },
    roundCount: empty ? 0 : 1, scoreTrend: { averageToParPerHole: .17, scoreHoles: 18 },
    totals: { c1_putt_hit: 14, c1_putt_att: 18, c1x_putt_hit: 8, c1x_putt_att: 12, c2_putt_hit: 1, c2_putt_att: 4,
      shot_verified_holes: 8, shot_eligible_holes: 18, shot_count_matched_holes: 5, shot_incomplete_holes: 5 },
    latest: { rounds: 1, averageToParPerHole: .17, scoreHoles: 18, c1x: { percentage: 66.7, attempts: 12 } },
    previous: { rounds: 0, averageToParPerHole: null, scoreHoles: 0, c1x: { percentage: null, attempts: 0 } },
    coverage: {},
    recentRounds: [{ id: "casual:5", source: "casual", date: now.slice(0, 10), course: course.name, layout: layout.name,
      scoredHoles: 18, strokes: 57, toPar: 3, group: "singles", explicitLedgerHoles: 0 }],
  });
  else if (path === "/my-play-export") {
    if (request.headers.authorization !== "Bearer member-token") return reply({ error: "unauthorized" }, 401);
    fixture.playExportQueries.push(Object.fromEntries(query));
    const format = query.get("format");
    const cursor = query.get("cursor");
    if (!["csv", "json"].includes(format) || (cursor && cursor !== playCursor)) return reply({ error: "invalid_export" }, 400);
    const archive = playExportPage(cursor);
    const headers = cursor ? {} : { "X-GVDG-Next-Export": playCursor };
    if (format === "csv") reply(playExportCsv(archive), 200, "text/csv", headers);
    else reply(archive, 200, "application/json", headers);
  }
  else if (path === "/me/udisc-history") {
    const imported = { id: 12, courseName: course.name, layoutName: layout.name, playedAt: "2026-11-12T15:20:00", total: 55, toPar: 1 };
    // Long course and layout names, and a big over-par score, as real UDisc exports have: none may push a row
    // (or, through the shared grid column, every row) past the screen edge.
    const long = [
      { id: 13, courseName: "ECU - North Recreational Complex", layoutName: "Pirates Walk", playedAt: "2026-05-03T10:15:00", total: 47, toPar: -7 },
      { id: 14, courseName: "Farmville DiscGolfPark", layoutName: "White Pads to B-Pins Championship Long Layout", playedAt: "2026-05-28T18:50:00", total: 55, toPar: 1 },
      { id: 15, courseName: "West Meadowbrook Park", layoutName: "Gold Layout", playedAt: "2025-12-14T14:04:00", total: 81, toPar: 27 },
      { id: 16, courseName: "ThisIsAnUnbrokenCourseNameFromAnExportWithNoSpaces", layoutName: "Kings Cup Amateur", playedAt: "2026-02-06T09:43:00", total: 104, toPar: 50 },
    ];
    reply(request.method === "GET" ? { rounds: empty ? [] : [imported, ...long] } : { saved: 1 });
  }
  else if (path === "/shop/wallet") reply({ balance_cents: empty ? 0 : 3250,
    transactions: empty ? [] : [{ id: 1, amount_cents: 3250, source: "event_payout", created_at: now }] });
  else if (path === "/registration/open" || path === "/events") reply({ events: empty ? [] : [event, alternatives] });
  else if (path === "/leagues/schedule") reply({ events: empty ? [] : [
    { id: 71, league_id: 9, league_name: "Sunday Baggers", season: "2026", name: "Sunday Baggers Nov 8th", date: "2026-11-08", status: "final" },
    { id: 72, league_id: 9, league_name: "Sunday Baggers", season: "2026", name: "Sunday Baggers Nov 22nd", date: "2026-11-22", status: "scheduled" },
  ] });
  else if (path === "/my-registrations") reply({ registrations: empty ? [] : [{ event_id: 52, division: "MA2", paid_entry: false },
    { event_id: 61, event_name: "Fall Finale Doubles", event_status: "final", event_date: "2026-09-13", course_name: "Rocky Ford",
      division: "MA2", paid_entry: 1, checked_in: 1 }] });
  else if (path === "/courses") reply({ courses: empty ? [] : [course] });
  else if (path === "/courses/7/layouts") reply({ layouts: empty ? [] : [layout] });
  else if (path === "/course-traffic") reply({ courses: [] });
  else if (path === "/casual-rounds") reply({ requests: [] });
  else if (path === "/course-conditions") reply({ reports: empty ? [] : [{ id: 1, course_id: 7, course_name: course.name,
    member_name: "Jordan", status: "wet", note: "Low spots on hole seven", created_at: now }] });
  else if (path === "/board" && request.method === "POST") {
    const body = await readBody(request);
    const post = { id: 44, member_id: member.sub, author_name: member.name, created_at: "Today", body: body.body, replies: [] };
    const parent = fixture.posts.find((item) => item.id === body.parent_id);
    if (parent) parent.replies.push(post);
    else fixture.posts.unshift(post);
    reply({ post }, 201);
  }
  else if (path === "/board") reply({ posts: empty ? [] : fixture.posts });
  else if (path === "/my-tee-signs") reply({ teeSigns: fixture.signs });
  else if (path === "/tee-signs" && request.method === "POST") {
    const payload = await readBody(request);
    fixture.signs.push({ id: 12, course_id: payload.courseId, hole_number: payload.hole, status: "candidate",
      created_at: now, content_type: "image/png" });
    reply({ teeSign: fixture.signs[0] }, 201);
  }
  else if (path === "/bag-tags/mine") reply({ series: { name: "Greenville 2026" }, mine: null });
  else if (path === "/me/practice") reply({ owner: member.sub, discs: empty ? [] : [disc],
    throws: { items: [], next: null }, putting: { items: empty ? [] : [putt], next: null },
    puttingTotals: empty ? { attempts: 0, makes: 0, sessions: 0 } : { attempts: 25, makes: 18, sessions: 1 }, puttingTrends: [], throwGroups: [] });
  else if (path === "/leagues/active") reply({ leagues: [] });
  else if (path === "/me/community") reply({ profile: fixture.profile, progress, contacts: empty ? [] : [{ key: friendKey, displayName: "Jordan Parker", relation: "incoming" }], blocked: [] });
  else if (path === "/me/community/profile") {
    fixture.profile = { ...fixture.profile, ...await readBody(request), revision: fixture.profile.revision + 1 };
    reply({ profile: fixture.profile });
  }
  else if (path === "/community/directory") reply({ profiles: empty ? [] : [{ key: friendKey, displayName: "Jordan Parker" }], more: false });
  else if (path === "/community/profiles/" + profileKey) reply({ profile: fixture.profile });
  else if (path === "/me/course-favorites") reply({ courseIds: fixture.favorite ? [course.id] : [] });
  else if (path === "/me/course-favorites/7") {
    fixture.favorite = request.method === "PUT";
    reply({ favorite: fixture.favorite });
  }
  else if (path === "/community/courses") reply({ courses: empty || (query.has("favorites") && !fixture.favorite) ? [] : [course], more: false });
  else if (path === "/community/courses/7/reviews") reply({ course, mine: null, more: false,
    reviews: [{ id: 31, rating: 4, text: "Good practice basket by the parking lot.", publishedAt: now, own: false, reported: false }] });
  else if (path === "/market/me") reply(empty ? { waiting: 0, listings: [], selling: [], buying: [], offersIn: [], offersOut: [], wanted: [], feedbackToLeave: [], recentDeals: [], settings: null } : {
    waiting: 2, listings: [], offersOut: [], wanted: [], recentDeals: [], settings: { paypalMe: "TaylorDiscs", cashtag: "", zelle: "", notifyEmail: "" },
    selling: [{ id: 6, listingId: 7, listingTitle: "MVP Neutron Tesla", kind: "buy", status: "pending", priceCents: 1600, role: "seller",
      buyer: { key: "t_g", name: "Casey Guest", kind: "guest" }, seller: { key: "t_me", name: member.name, kind: "member" } }],
    offersIn: [{ id: 4, listingId: 7, listingTitle: "MVP Neutron Tesla", status: "open", text: "My Thunderbird plus $5", offered: [],
      buyer: { key: "t_x", name: "Jordan Parker", kind: "member" }, createdAt: now }],
    buying: [], feedbackToLeave: [],
  });
  else if (path === "/lost-found/me") reply(empty ? { karma: { karma: 0, returned: 0 }, posts: [], matches: [], claims: [] } : {
    karma: { karma: 30, returned: 3 }, posts: [],
    matches: [{ id: 3, status: "notified", strength: "strong", reasons: ["The phone number on the disc matches"],
      found: { id: 9, kind: "found", brand: "Innova", plastic: "Champion", mold: "Firebird (Bottom Stamp)", photos: [], photoPending: 0 } }],
    claims: [{ id: 5, status: "returned", role: "owner", found: { id: 8, brand: "Discraft", plastic: "ESP", mold: "Buzzz" },
      finder: { key: "t_f", name: "Casey Guest-Longname", kind: "guest" }, owner: { key: "t_me", name: member.name, kind: "member" } }],
  });
  else if (path === "/assistant") { fixture.asks += 1; reply({ reply: "Check the club schedule for the next round." }); }
  else reply({});
}

const vite = await createServer({
  configFile: false, cacheDir: await mkdtemp(join(tmpdir(), "gvdg-subpage-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_MEMBER_SURFACE_PORT || 5193), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{ name: "member-subpages-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      const ref = new URL(request.headers.referer || "http://localhost").searchParams;
      if (url.pathname === "/gvdg-members.html") {
        const mode = url.searchParams.get("mode") || "light";
        const token = url.searchParams.has("guest") ? "" : "member-token";
        const seed = '<script>if(' + Boolean(token) + '&&!localStorage.getItem("gvdg_member_token"))localStorage.setItem("gvdg_member_token",' +
          JSON.stringify(token) + ');localStorage.setItem("theme",' + JSON.stringify(mode === "light" ? "light" : "dark") +
          ');localStorage.setItem("gvdg_recent_rounds",JSON.stringify([{code:"RIVER7",label:"Rocky Ford · Long tees",updatedAt:Date.now()}]));</script>';
        const font = localFont ? '<style>@font-face{font-family:Archivo;src:url(/preview-font.woff2);font-weight:400 900;font-display:swap}</style>' : "";
        const html = (await readFile("gvdg-members.html", "utf8")).replace(/<link[^>]+https:[^>]+>/g, "")
          .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
          .replace('data-auth-base=""', 'data-auth-base="' + apiRoot + '"')
          .replace(/src="members-app\/[^"]+"/, 'src="/src/members-app/main.js"')
          .replace("<head>", "<head>" + seed + font + (url.searchParams.has("large") ? "<style>html{font-size:20px}</style>" : ""));
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(await server.transformIndexHtml(url.pathname, html));
        return;
      }
      if (url.pathname === "/preview-font.woff2" && localFont) {
        response.writeHead(200, { "Content-Type": "font/woff2" });
        response.end(localFont); return;
      }
      if (!url.pathname.startsWith(apiRoot + "/")) { next(); return; }
      await serveFixture(url.pathname.slice(apiRoot.length), url.searchParams, request, ref, (data, status = 200, type = "application/json", headers = {}) => {
        response.writeHead(status, { "Content-Type": type, ...headers });
        response.end(type === "application/json" ? JSON.stringify(data) : data);
      });
    });
  } }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
if (process.env.GVDG_MEMBER_SURFACE_SERVE) {
  console.log(origin + "/gvdg-members.html?mode=blue#play");
  console.log(origin + "/gvdg-members.html?mode=light&large#appearance");
  await new Promise((resolve) => process.once("SIGTERM", resolve));
  await vite.close();
  process.exit(0);
}

await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function pageFor(width, mode, run, extra = "") {
  const context = await browser.newContext({ viewport: { width, height: 870 }, serviceWorkers: "block", acceptDownloads: true });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(45_000);
  const url = origin + "/gvdg-members.html?mode=" + mode + "&run=" + run + extra + (width === 320 ? "&large" : "");
  async function go(hash = "") { await page.goto(url + (hash ? "#" + hash : ""), { waitUntil: "commit" }); }
  async function screen(name) {
    await page.evaluate(() => document.fonts.ready);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(fits, true, name + " viewport width");
    // No action label may be cut off. Buttons are flex containers, where text-overflow: ellipsis never
    // renders, so an overflowing label is silently clipped on both sides.
    const clipped = await page.evaluate(() => [...document.querySelectorAll("#members :is(button, a, .dashboard-action, .passkey-btn)")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || element.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
        const style = getComputedStyle(element);
        if (style.overflowX === "visible" || element.scrollWidth <= element.clientWidth + 1) return false;
        return !(style.textOverflow === "ellipsis" && !/flex|grid/.test(style.display));
      })
      .map((element) => {
        const style = getComputedStyle(element);
        return (element.textContent || "").trim().slice(0, 40) + " (" + element.scrollWidth + ">" + element.clientWidth
          + " in ." + String(element.parentElement?.className || element.parentElement?.tagName).split(" ")[0]
          + " " + style.whiteSpace + " max " + style.maxWidth + ")";
      }));
    assert.deepEqual(clipped, [], name + " has clipped action labels");
    // Nothing on screen may sit past the screen edge. A clipping ancestor (overflow: hidden / clip) stops the page
    // from scrolling sideways, so the width check above passes while scores and buttons are cut off at the edge.
    const offscreen = await page.evaluate(() => [...document.querySelectorAll("#members *")]
      .filter((element) => {
        if (element.closest("[hidden], [aria-hidden='true'], [inert], dialog:not([open])")) return false;
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || box.bottom < 0 || box.top > innerHeight * 4) return false;
        if (getComputedStyle(element).visibility === "hidden") return false;
        if (box.right <= innerWidth + 1 && box.left >= -1) return false;
        // Sideways scrollers (tab rows, wide tables) are meant to run past the edge.
        for (let up = element.parentElement; up && up !== document.body; up = up.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(up).overflowX)) return false;
        }
        // Report the outermost escaping element only.
        const parent = element.parentElement?.getBoundingClientRect();
        return !parent || parent.right <= innerWidth + 1;
      })
      .map((element) => "." + String(element.className || element.tagName).split(" ")[0] + " \"" + (element.textContent || "").trim().slice(0, 30)
        + "\" right " + Math.round(element.getBoundingClientRect().right) + " > " + innerWidth));
    assert.deepEqual(offscreen, [], name + " has content past the screen edge");
    await page.screenshot({ path: join(screenshotDir, name + ".png"), animations: "disabled" });
  }
  return { page, context, errors, url, go, screen };
}

const readiness = {
  overview: "[data-react-home-hero]", play: "[data-react-play-join]", events: "[data-member-event-id='51']",
  season: "[data-react-season-page='ready']", more: "[data-react-more-page]", club: "[data-react-club-panel]",
  community: "[data-member-community]", "course-discovery": ".member-course-results li", board: ".board-post", tee: "#reactTsPhotoInput",
  standings: "[data-react-active-standings='empty']",
  tags: "[data-react-bag-tags]", account: "[data-member-account-devices]", appearance: ".member-appearance", wallet: "[data-react-wallet='ready']",
  imports: "[data-react-udisc-history='ready']", practice: "[data-member-practice]", "my-bag": "[data-member-bag]",
  marketplace: "[data-member-marketplace='ready']",
  "lost-found": "[data-member-lost-found='ready']",
};

/** "Add to calendar" opens a menu (not a bare download): Google / Outlook pages filled in, or the .ics file; it fits the
 *  screen, and Escape closes it and returns focus to the button. */
async function checkCalendarMenu(page, card, width) {
  const button = card.getByRole("button", { name: "Add to calendar" });
  await button.click();
  const menu = page.getByRole("menu", { name: "Add to calendar" });
  await menu.waitFor();
  await menu.getByRole("menuitem").nth(2).waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Google Calendar", "Outlook", "Other calendar app (.ics file)"]);
  const google = new URL(await menu.getByRole("menuitem", { name: "Google Calendar" }).getAttribute("href"));
  assert.deepEqual([google.hostname, google.searchParams.get("dates"), google.searchParams.get("text")],
    ["calendar.google.com", "20261212/20261214", "Greenville Winter Classic Presented by the Pitt County Disc Golf Association"]);
  assert.equal(await menu.getByRole("menuitem").first().evaluate((node) => node === document.activeElement), true, "the first choice takes focus");
  const box = await menu.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= width + 1, "the calendar menu fits the screen at " + width + "px");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await button.evaluate((node) => node === document.activeElement), true, "focus returns to the button");
  const [download] = await Promise.all([page.waitForEvent("download"), (async () => {
    await button.click();
    await menu.getByRole("menuitem", { name: "Other calendar app (.ics file)" }).click();
  })()]);
  assert.match(download.suggestedFilename(), /\.ics$/);
  await menu.waitFor({ state: "detached" });
}

async function verifyDestinations(width, mode) {
  const view = await pageFor(width, mode, width + "-" + mode);
  try {
    for (const item of MEMBER_DESTINATIONS) {
      await view.go(item.hash);
      if (item.key === "overview") {
        await view.page.locator("#myDashboard [data-react-live-scoring='ready']").waitFor();
        // Next PDGA is the member's own registered event, found on PDGA's registration lists.
        const next = view.page.locator("[data-react-home-pdga='registered']");
        await next.getByText("You're registered · MA2").waitFor();
        await next.getByText("Also going: Jordan Parker (MA3)", { exact: false }).waitFor();
        await next.locator(".karma-chip[data-karma='40']").waitFor();
        assert.equal(await next.locator(".karma-chip").count(), 1, "only the clubmate with karma gets a chip");
        // Your own karma, next to your name on the Home card; the chip stays whole however long the name.
        const own = view.page.locator("[data-react-home-hero] .player-who h2 .karma-chip[data-karma='30']");
        await own.waitFor();
        const ownBox = await own.boundingBox();
        const heroBox = await view.page.locator("[data-react-home-hero] .player-who").boundingBox();
        assert.ok(ownBox && heroBox && ownBox.x + ownBox.width <= heroBox.x + heroBox.width + 1, width + " own karma chip fits beside the name");
        if (process.env.GVDG_KARMA_SHOTS) await view.page.locator("[data-react-home-hero]").screenshot({ path: process.env.GVDG_KARMA_SHOTS + "/home-hero-" + width + "-" + mode + ".png" });
      }
      if (item.key === "account") {
        await view.page.locator(".member-settings-profile h2 .karma-chip[data-karma='30']").waitFor();
      }
      await view.page.getByRole("heading", { name: item.label, level: 1, exact: true }).waitFor();
      if (readiness[item.key]) await view.page.locator(readiness[item.key]).first().waitFor({ state: "attached" });
      if (item.key === "events") {
        const mine = view.page.locator("section[aria-label='My events']");
        await mine.waitFor();
        assert.equal(await mine.getByText("Fall Finale Doubles").count(), 0, "finished events leave My events");
        // PDGA events the member is registered for join My events; clubmates' others get their own section.
        const pdga = mine.locator("[data-pdga-registration='501'][data-pdga-mine='true']");
        await pdga.getByText("You're registered · MA2").waitFor();
        await pdga.getByText("Also going: Jordan Parker (MA3)", { exact: false }).waitFor();
        assert.equal(await pdga.locator(".karma-chip").getAttribute("title"), "40 karma");
        assert.equal(await pdga.getByRole("link", { name: "PDGA page" }).getAttribute("href"), "https://www.pdga.com/tour/event/501");
        await view.page.locator("[data-pdga-club-going='1'] [data-pdga-registration='502']").getByText("Going: Jordan Parker (MA3)").waitFor();
        await checkCalendarMenu(view.page, pdga, width);
      }
      if (item.key === "board") {
        // Karma next to the post author's name.
        await view.page.locator(".board-post .karma-chip[data-karma='30']").first().waitFor();
      }
      if (item.key === "standings") {
        await view.page.getByText("No league standings right now.", { exact: false }).waitFor();
      }
      if (item.key === "leagues") {
        const schedule = view.page.locator("[data-react-league-schedule='ready']");
        await schedule.getByText("Sunday Baggers Nov 22nd").waitFor();
        assert.equal(await schedule.getByText("Sunday Baggers Nov 8th").count(), 0, "finished league rounds leave the schedule");
      }
      if (item.key === "results") {
        await view.page.locator("section[aria-label='Completed league rounds']").getByText("Sunday Baggers Nov 8th").waitFor();
        await view.page.locator("section[aria-label='Your completed events']").getByText("Fall Finale Doubles").waitFor();
      }
      await view.screen(item.key + "-" + width + "-" + mode);
    }
    assert.deepEqual(view.errors, []);
    assert.equal(seededFixture(width + "-" + mode).themeWrites, 0, "navigation does not overwrite saved theme");
    console.log(MEMBER_DESTINATIONS.length + " destinations verified at " + width + "px in " + mode);
  } finally { await view.context.close(); }
}

async function verifyPlayDownloads(page, fixture) {
  await page.getByText("Download my play data", { exact: true }).click();
  const formats = page.getByRole("group", { name: "Download format", exact: true });
  for (const format of ["json", "csv"]) {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      formats.getByRole("button", { name: "Download " + format.toUpperCase(), exact: true }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "gvdg-play-history." + format);
    const contents = await readFile(await download.path(), "utf8");
    if (format === "json") {
      assert.deepEqual(JSON.parse(contents), {
        schemaVersion: playSchema, memberId: member.sub, exportedAt: now,
        rounds: [playRound], clips: [playClip],
      });
    } else {
      const [header, ...rows] = contents.trimEnd().split("\r\n");
      assert.equal(header, playCsvHeader);
      assert.deepEqual(rows.map((row) => row.split(",", 1)[0]), ["manifest", "round", "hole", "clip"]);
      assert.deepEqual(rows[2].split(",", 11), [
        "hole", playSchema, member.sub, playRound.id, playRound.source, now, course.name, layout.name, "1", "3", "4",
      ]);
      assert.ok(rows[2].includes('""lat"":35.62'));
      assert.ok(rows[3].includes(playClip.mediaPath));
    }
  }
  assert.deepEqual(fixture.playExportQueries, [
    { format: "json" }, { format: "json", cursor: playCursor },
    { format: "csv" }, { format: "csv", cursor: playCursor },
  ], "Downloads request all pages independently of the history filters");
}

async function verifyActions(width, mode) {
  const view = await pageFor(width, mode, "actions-" + width);
  const { page, go, screen } = view;
  try {
    await go("home");
    const playTab = page.getByRole("navigation", { name: "Member app" }).getByRole("button", { name: "Play" });
    await playTab.focus();
    await page.keyboard.press("Enter");
    const playHeading = page.getByRole("heading", { name: "Play", level: 1 });
    await playHeading.waitFor();
    await page.waitForFunction(() => document.activeElement?.dataset.navigationFocus === "keyboard");
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await page.getByRole("alert").getByText("Enter a 4+ character round code.").waitFor();
    await screen("invalid-round-code-" + width);
    assert.equal(await page.getByLabel("Round code").getAttribute("aria-invalid"), "true");
    await page.getByText("Find a course", { exact: true }).click();
    await page.getByLabel("Course name or town").fill("Meadowbrook");
    await page.getByRole("link", { name: /West Meadowbrook Park/ }).waitFor();
    await page.route(/\/score\.html\?/, (route) => route.fulfill({ contentType: "text/html", body: "<title>Score destination</title>" }));
    await page.getByLabel("Round code").fill("river7");
    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await page.waitForURL(/score\.html\?round=RIVER7&watch=1/);
    await go("play");
    await page.getByLabel("Round code").fill("river7");
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await page.waitForURL(/score\.html\?round=RIVER7$/);

    await go("events?event=51");
    await page.locator("[data-member-event-id='51']").getByRole("combobox", { name: "Division" }).selectOption("FA2");
    const eventCard = page.locator("[data-member-event-id='51']");
    await eventCard.scrollIntoViewIfNeeded();
    await screen("event-registration-" + width);
    await page.locator("summary").filter({ hasText: "Casual rounds" }).click();
    await page.getByRole("button", { name: "Post casual round" }).waitFor();
    await screen("event-casual-form-" + width);

    await go("stats");
    const filters = page.getByRole("form", { name: "Filter my play history" });
    await filters.getByLabel("Period").selectOption("custom");
    await filters.getByLabel("Start date").fill("2026-11-30");
    await filters.getByLabel("End date").fill("2026-11-01");
    await filters.getByRole("button", { name: "Apply filters" }).click();
    await filters.getByRole("alert").waitFor();
    await verifyPlayDownloads(page, seededFixture("actions-" + width));

    await go("appearance");
    await page.getByText("Live scoring disc", { exact: true }).click();
    await page.getByRole("radiogroup", { name: "Disc color" }).waitFor();
    const themeHeader = page.locator(".dash-theme-header");
    if (!await themeHeader.isVisible()) await page.getByText("Dashboard theme", { exact: true }).click();
    await themeHeader.waitFor();
    assert.equal(await themeHeader.evaluate((node) => getComputedStyle(node).position), "static");
    await screen("appearance-editor-" + width);
    await go("account");
    await page.getByRole("button", { name: "Edit profile" }).click();
    await page.getByLabel("PDGA # (optional)").waitFor();
    await page.locator("#photoInput").focus();
    assert.equal(await page.locator("#photoInput").evaluate((input) => input === document.activeElement), true);
    await screen("profile-edit-" + width);
    await page.getByRole("button", { name: "Skip for now" }).click();

    await go("tee");
    const upload = page.getByRole("button", { name: "Upload tee sign" });
    assert.equal(await upload.isDisabled(), true);
    await page.locator("#reactTsPhotoInput").focus();
    assert.equal(await page.locator("#reactTsPhotoInput").evaluate((input) => input === document.activeElement), true);
    await page.locator("#reactTsPhotoInput").setInputFiles({
      name: "fixture.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8x8AAwMCAO+/p94AAAAASUVORK5CYII=", "base64"),
    });
    await page.getByAltText("Tee-sign photo preview").waitFor();
    assert.equal(await upload.isEnabled(), true);
    await screen("tee-upload-" + width);
    await upload.click();
    await page.getByText("Uploaded. Crotts is reading the sign.").waitFor();
    assert.equal(await upload.isDisabled(), true);

    await go("course-discovery");
    await page.getByText("Amenities and accessibility", { exact: true }).click();
    await page.getByLabel("Difficulty").selectOption("intermediate");
    await page.getByRole("button", { name: "Find courses" }).click();
    await page.getByRole("button", { name: "Save as favorite" }).click();
    const favorite = page.getByRole("button", { name: "Remove favorite" });
    await favorite.waitFor();
    assert.equal(await favorite.getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Course details for West Meadowbrook Park" }).click();
    await page.getByRole("link", { name: "Open course map" }).waitFor();
    await screen("course-details-" + width);
    await page.getByRole("button", { name: "Write a review" }).click();
    await page.getByLabel("Rating", { exact: true }).selectOption("4");
    await screen("course-review-" + width);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await go("community");
    await page.getByLabel("Who can see your profile?").selectOption("private");
    assert.equal(await page.getByLabel("Share my total completed GVDG rounds with this audience").isDisabled(), true);
    await page.getByText("Saving this change disables the current public link.").waitFor();
    await screen("community-private-" + width);
    await page.getByRole("button", { name: "Save profile settings" }).click();
    await page.getByText("Profile settings saved.").waitFor();
    await go("board");
    await page.getByRole("button", { name: "Reply", exact: true }).first().click();
    const replyBox = page.locator(".board-replybox");
    await replyBox.locator("textarea").fill("I’ll see you there.");
    await screen("board-reply-" + width);
    await replyBox.getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByText("I’ll see you there.", { exact: true }).waitFor();

    await go("home");
    await page.getByRole("link", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Crotts assistant" });
    await help.waitFor();
    assert.equal(await help.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    await screen("help-" + width);
    await help.getByLabel("Message Crotts").fill("When is the next round?");
    await help.getByRole("button", { name: "Send", exact: true }).click();
    await help.getByText("Check the club schedule for the next round.").waitFor();
    await help.getByRole("button", { name: "Close Crotts assistant" }).click();
    assert.equal(seededFixture("actions-" + width).asks, 1);
    assert.deepEqual(view.errors, []);
    console.log("Nested forms and actions verified at " + width + "px");
  } finally { await view.context.close(); }
}

async function verifyAuth() {
  const view = await pageFor(390, "light", "auth", "&guest");
  const { page, go, screen } = view;
  try {
    await go();
    await page.getByRole("heading", { name: "Members Only" }).waitFor();
    await screen("sign-in-390");
    await page.getByRole("button", { name: "Apply for a club login" }).click();
    await page.getByRole("heading", { name: "Join the Club" }).waitFor();
    await screen("apply-390");
    const application = page.locator("#applyForm");
    await application.getByLabel("Name", { exact: true }).fill("New Member");
    await application.getByLabel("PDGA #", { exact: true }).fill("123456");
    await application.getByLabel("Choose a PIN").fill("1234");
    await application.getByLabel("Confirm PIN").fill("1234");
    const submitted = page.waitForResponse((response) => response.url().endsWith("/membership/apply"));
    await application.getByRole("button", { name: "Submit application" }).click();
    assert.equal((await submitted).status(), 201);
    await page.getByText("Application sent. After an admin approves you, log in with this PIN.", { exact: true }).waitFor();
    await page.getByLabel("PDGA #, UDisc username or email").fill("bad");
    await page.getByLabel("PIN", { exact: true }).fill("0000");
    await page.getByRole("button", { name: "Log In", exact: true }).click();
    await page.locator('[data-react-auth-error="login"][data-react-auth-error-state="shown"]').waitFor();
    await screen("sign-in-error-390");
    await page.getByLabel("PDGA #, UDisc username or email").fill("123456");
    await page.getByLabel("PIN", { exact: true }).fill("1234");
    await page.getByRole("button", { name: "Log In", exact: true }).click();
    await page.locator("[data-react-auth-gate='pin']").waitFor();
    await screen("temporary-pin-390");
    const pinChange = page.locator("#pinChangeForm");
    await pinChange.getByLabel("New PIN", { exact: true }).fill("1010");
    await pinChange.getByLabel("Confirm PIN", { exact: true }).fill("1010");
    await pinChange.locator("button[type=submit]").click();
    await page.getByRole("heading", { name: "Home", level: 1 }).waitFor();
    assert.deepEqual(view.errors, []);
    const shared = await pageFor(390, "light", "shared-profile", "&guest&profile=" + profileKey);
    try {
      await shared.go();
      await shared.page.getByRole("heading", { name: "Taylor Morgan", exact: true }).waitFor();
      await shared.page.getByRole("link", { name: "Open the member app" }).waitFor();
      await shared.screen("public-profile-390");
    } finally { await shared.context.close(); }
    console.log("Signed-out, application, failed login, temporary PIN, and shared profile screens verified");
  } finally { await view.context.close(); }
}

async function verifyStates() {
  for (const state of ["loading", "empty", "error"]) {
    const view = await pageFor(390, "blue", "states-" + state, "&state=" + state);
    try {
      await view.go("course-discovery");
      await view.page.getByText(
        state === "loading" ? "Loading courses…" : state === "error" ? "Courses couldn’t load." : "No courses match these filters.",
        { exact: true }
      ).waitFor();
      await view.screen("course-discovery-" + state);
      if (state !== "loading") {
        await view.go("board");
        await view.page.getByText(state === "error" ? "Board posts are temporarily unavailable." : "No posts yet.").waitFor();
        await view.screen("board-" + state);
      }
      assert.deepEqual(view.errors, []);
    } finally { await view.context.close(); }
  }
  console.log("Loading, empty, and explicit error states verified");
}

try {
  const phase = process.env.GVDG_MEMBER_SURFACE_PHASE;
  if (!phase || phase === "routes") {
    await verifyDestinations(390, "blue");
    await verifyDestinations(1280, "light");
    await verifyDestinations(320, "dark");
  }
  if (!phase || phase === "actions") await verifyActions(390, "blue");
  if (!phase || phase === "auth" || phase === "actions" || phase === "states") await verifyAuth();
  if (!phase || phase === "states" || phase === "actions") await verifyStates();
  console.log("Evidence " + screenshotDir);
} finally {
  await browser.close();
  await vite.close();
}
