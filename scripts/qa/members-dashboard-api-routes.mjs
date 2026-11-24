// /pdga-stats combines PDGA's official REST API (official rating + date) with documented PDGA Live API
// round ratings and detailed /api/v1/ throw/putting stats.
const stats = {
  pdga: "90000001",
  name: "GVDG QA Dashboard",
  official_rating: 935,
  rating_date: "2026-07-01",
  previous_rating: null,
  previous_rating_date: null,
  live_rating: 941,
  peak_rating: 958,
  events_count: 2,
  annual_stats: [
    {
      year: 2026,
      divisionCode: "MA1",
      divisionName: "Mixed Amateur 1",
      classification: "A",
      rating: 935,
      events: 8,
      points: 412,
      prize: 240,
      playersDefeated: 185,
      wins: 2,
      url: "https://www.pdga.com/player/90000001/stats/2026",
    },
    {
      year: 2025,
      divisionCode: "MA1",
      divisionName: "Mixed Amateur 1",
      classification: "A",
      rating: 924,
      events: 11,
      points: 530,
      prize: 190,
      playersDefeated: 210,
      wins: 1,
      url: "https://www.pdga.com/player/90000001/stats/2025",
    },
  ],
  events: [
    {
      tournament: "GVDG QA Monthly",
      date: "2026-06-20",
      epoch: 1781913600,
      division: "MA1",
      eventId: "900001",
      place: 2,
      total: 108,
      to_par: -6,
      average_rating: 958,
      dnf: false,
      live_url: "https://www.pdga.com/live/event/900001/MA1/scores",
      rounds: [{
        rating: 958,
        score: 54,
        round: "1",
        to_par: -3,
        date: "2026-06-20",
        complete: true,
        holes: 18,
        birdies: 6,
        pars: 9,
        bogeys: 3,
        stats: { fwh: { hit: 14, opp: 18 }, c1x: { hit: 9, opp: 10 } },
      }],
    },
    {
      tournament: "GVDG QA League",
      date: "2026-05-12",
      epoch: 1778544000,
      division: "MA1",
      eventId: "900002",
      place: 4,
      total: 57,
      to_par: 0,
      average_rating: 924,
      dnf: false,
      live_url: "https://www.pdga.com/live/event/900002/MA1/scores",
      rounds: [{ rating: 924, score: 57, round: "1", to_par: 0, date: "2026-05-12", complete: true }],
    },
  ],
  play: {
    holes: 36,
    aces: 0,
    eagles: 1,
    birdies: 9,
    pars: 18,
    bogeys: 7,
    doubles_plus: 1,
    birdie_hit: 9,
    par_hit: 18,
    fir_hit: 24,
    fir_att: 32,
    c1r_hit: 14,
    c1r_att: 36,
    c2r_hit: 22,
    c2r_att: 36,
    parked_hit: 4,
    parked_att: 36,
    scramble_hit: 4,
    scramble_att: 7,
    c1_putt_hit: 26,
    c1_putt_att: 29,
    c1x_putt_hit: 14,
    c1x_putt_att: 17,
    c2_putt_hit: 2,
    c2_putt_att: 8,
  },
  play_rounds: [
    {
      tournament: "GVDG QA Monthly",
      date: "2026-06-20",
      division: "MA1",
      round: "1",
      group_format: "singles",
      scoring_style: "stroke",
      breakdown: {
        holes: 36,
        birdies: 9,
        pars: 18,
        bogeys: 7,
        doubles_plus: 1,
        eagles: 1,
        fir_hit: 24,
        fir_att: 32,
        c1r_hit: 14,
        c1r_att: 36,
        c2r_hit: 22,
        c2r_att: 36,
        parked_hit: 4,
        parked_att: 36,
        scramble_hit: 4,
        scramble_att: 7,
        c1_putt_hit: 26,
        c1_putt_att: 29,
        c1x_putt_hit: 14,
        c1x_putt_att: 17,
        c2_putt_hit: 2,
        c2_putt_att: 8,
      },
    },
  ],
  source: "pdga-api",
  stats_version: 5,
};

const myRatings = {
  competitive: {
    live_rating: 906,
    rated_rounds: 1,
    rounds_count: 1,
    rounds: [
      {
        id: 101,
        label: "GVDG QA Weekly",
        date: "2026-07-04",
        place: 2,
        total: 56,
        to_par: 2,
        rating: 906,
        rating_source: "stored",
        udisc_course_id: "12345678",
        scorecard: JSON.stringify([
          { hole: 1, par: 3, strokes: 3 },
          { hole: 2, par: 3, strokes: 4 },
          { hole: 3, par: 3, strokes: 3 },
        ]),
      },
    ],
  },
  casual: {
    live_rating: 890,
    rated_rounds: 2,
    rounds_count: 2,
    rounds: [
      {
        id: 203,
        label: "Ayden Park - Main Layout",
        date: "2026-07-12T14:00:00Z",
        total: 55,
        to_par: -4,
        rating: 948,
        rating_source: "stored",
        rating_method: "layout",
        propagator_count: 4,
        udisc_course_id: null,
        scorecard: JSON.stringify([
          { hole: 1, par: 3, strokes: 3 },
          { hole: 2, par: 3, strokes: 2 },
          { hole: 3, par: 3, strokes: 3 },
        ]),
      },
      {
        id: 202,
        label: "ECU North Rec Complex - Pee Dee's Treasure Map",
        date: "2026-07-05T14:00:00Z",
        total: 58,
        to_par: 4,
        rating: 890,
        rating_source: "estimated",
        udisc_course_id: "12345678",
        scorecard: JSON.stringify([
          { hole: 1, par: 3, strokes: 4 },
          { hole: 2, par: 3, strokes: 3 },
          { hole: 3, par: 3, strokes: 4 },
        ]),
      },
    ],
  },
};

const openEvents = [
  {
    id: "event-qa-doubles",
    name: "GVDG QA Doubles",
    date: "2026-07-08",
    status: "scheduled",
    course_name: "ECU North Rec Complex",
    layout_name: "Pee Dee's Treasure Map",
    total_par: 54,
    entry_fee_cents: 500,
    play_format: "doubles",
    divisions: JSON.stringify(["MA2", "FA2"]),
    liveScoringConfig: { groupFormat: "doubles", scoringStyle: "stroke" },
  },
];

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lwytjAAAAABJRU5ErkJggg==", "base64");

function json(body, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function png(body, status = 200) {
  return { status, contentType: "image/png", body };
}

function initialBoardPost() {
  return {
    id: 501,
    member_id: "member-2",
    author_name: "QA Cardmate",
    created_at: "Jul 5, 2026",
    body: "**League night** is set for Wednesday.\n\n- Check in by 5:30",
    replies: [
      {
        id: 502,
        parent_id: 501,
        member_id: "member-1",
        author_name: "QA Admin",
        created_at: "Jul 5, 2026",
        body: "I can help with cards.",
      },
    ],
  };
}

function initialCasualRequest() {
  return {
    id: 31,
    course_id: 1,
    layout_id: 11,
    created_by: "other-member",
    created_by_name: "QA Cardmate",
    starts_at: "2026-07-06T22:00:00Z",
    notes: "Warm-up round before league",
    status: "open",
    round_code: null,
    created_at: "2026-07-05T12:00:00Z",
    updated_at: "2026-07-05T12:00:00Z",
    course_name: "ECU North Rec Complex",
    course_location: "Greenville, NC",
    layout_name: "Pee Dee's Treasure Map",
    player_count: 1,
    players: ["QA Cardmate"],
    committed: false,
  };
}

function postedCasualRequest(body) {
  return {
    id: 77,
    course_id: body.course_id,
    layout_id: body.layout_id,
    created_by: "member-1",
    created_by_name: "QA Admin",
    starts_at: body.starts_at,
    notes: body.notes,
    status: "open",
    round_code: null,
    created_at: "2026-07-06T12:00:00Z",
    updated_at: "2026-07-06T12:00:00Z",
    course_name: "ECU North Rec Complex",
    course_location: "Greenville, NC",
    layout_name: "Pee Dee's Treasure Map",
    player_count: 1,
    players: ["QA Admin"],
    committed: true,
  };
}

function initialTeeSign() {
  return {
    id: 701,
    course_id: 1,
    hole_number: 7,
    r2_key: "qa/sign-701.png",
    content_type: "image/png",
    bytes: tinyPng.length,
    uploaded_by: "member-1",
    created_at: "2026-07-05T18:00:00Z",
    status: "candidate",
    extracted_json: JSON.stringify({
      layouts: [
        { label: "Blue", par: 3, distance_ft: 318, color: "blue" },
        { label: "White", par: 3, distance_ft: 276, color: "white" },
      ],
    }),
    extract_source: "qa",
  };
}

export async function installMemberDashboardApiRoutes(page, apiBase) {
  const state = {
    announcements: [
      {
        id: 31,
        title: "Spring Course Update",
        body: "New tee signs are up on the back nine.",
        href: "/gvdg-members.html#events",
        authorName: "QA Admin",
        createdAt: "2026-07-06T12:00:00Z",
      },
    ],
    boardPostBody: null,
    boardPosts: [initialBoardPost()],
    casualPostBody: null,
    casualRequests: [initialCasualRequest()],
    nextBoardId: 503,
    nextTeeSignId: 702,
    teeSignPostBody: null,
    teeSigns: [initialTeeSign()],
    workdays: [
      {
        id: 21,
        title: "Course Cleanup & Mulching",
        description: "Meet near hole 1 kiosk. Bring gloves.",
        courseId: 1,
        locationName: "ECU North Rec Complex",
        workdayDate: "2026-07-06",
        startTime: "9:00 AM",
        karmaReward: 40,
        radiusFt: 2000,
        hasGps: true,
        status: "active",
        checkinOpen: true,
        announcedAt: "2026-07-01T14:00:00Z",
        signupCount: 1,
        checkedInCount: 0,
        verifiedCount: 0,
        signups: [
          { name: "QA Cardmate", karmaKey: "m_cardmate", status: "signed_up", signedUpAt: "2026-07-02T12:00:00Z", isMe: false },
        ],
        me: null,
      },
    ],
  };

  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathName = url.pathname;
    const method = request.method();

    if (pathName === "/announcements" && method === "GET") {
      return route.fulfill(json({ announcements: state.announcements }));
    }
    if (pathName === "/workdays" && method === "GET") {
      return route.fulfill(json({ workdays: state.workdays }));
    }
    const wdSignupMatch = pathName.match(/^\/workdays\/(\d+)\/signup$/);
    if (wdSignupMatch) {
      const wd = state.workdays.find((row) => row.id === Number(wdSignupMatch[1]));
      if (!wd) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
      if (method === "POST") {
        if (!wd.signups.some((s) => s.isMe)) {
          wd.signups.push({ name: "QA Admin", karmaKey: "m_qa", status: "signed_up", signedUpAt: "2026-07-06T08:45:00Z", isMe: true });
        }
        wd.signupCount = wd.signups.length;
        wd.me = { status: "signed_up", signedUpAt: "2026-07-06T08:45:00Z", gpsVerified: false, gpsDistanceFt: null, checkedInAt: null, verifiedAt: null, karmaAwarded: 0 };
        return route.fulfill(json({ ok: true, workday: wd }));
      }
      if (method === "DELETE") {
        wd.signups = wd.signups.filter((s) => !s.isMe);
        wd.signupCount = wd.signups.length;
        wd.me = null;
        return route.fulfill(json({ ok: true, workday: wd }));
      }
    }
    const wdCheckinMatch = pathName.match(/^\/workdays\/(\d+)\/check-in$/);
    if (wdCheckinMatch && method === "POST") {
      const wd = state.workdays.find((row) => row.id === Number(wdCheckinMatch[1]));
      if (!wd) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
      const body = request.postDataJSON() || {};
      const latDiff = Math.abs(Number(body.lat) - 35.6127);
      const lngDiff = Math.abs(Number(body.lng) - (-77.3664));
      if (!Number.isFinite(latDiff) || !Number.isFinite(lngDiff) || latDiff > 0.01 || lngDiff > 0.01) {
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "too_far", distanceFt: 5400, radiusFt: wd.radiusFt }),
        });
      }
      wd.signups = wd.signups.map((s) => (s.isMe ? { ...s, status: "checked_in" } : s));
      wd.checkedInCount = wd.signups.filter((s) => s.status === "checked_in").length;
      wd.me = {
        status: "checked_in",
        signedUpAt: "2026-07-06T08:45:00Z",
        gpsVerified: true,
        gpsDistanceFt: 120,
        checkedInAt: "2026-07-06T09:02:00Z",
        verifiedAt: null,
        karmaAwarded: 0,
      };
      return route.fulfill(json({ ok: true, distanceFt: 120, radiusFt: wd.radiusFt, workday: wd }));
    }

    if (pathName === "/me") return route.fulfill(json({ sub: "member-1", isAdmin: true, name: "QA Admin", pdgaNo: "90000001" }));
    if (pathName === "/pdga-stats") return route.fulfill(json(stats));
    if (pathName.startsWith("/my-ratings")) return route.fulfill(json(myRatings));
    if (pathName === "/my-results") return route.fulfill(json({
      results: [
        { id: 1, event_id: 10, event_name: "GVDG QA Weekly", event_date: "2026-07-04", place: 2, total: 56, to_par: 2 },
      ],
    }));
    if (pathName === "/play-stats") return route.fulfill(json({
      year: 2026,
      competitive: {
        mine: { memberId: "member-1", name: "QA Admin", totals: { holes: 18, aces: 0, eagles: 1, birdies: 3, pars: 8, bogeys: 5, doubles_plus: 1, birdie_hit: 3, par_hit: 8 } },
        categories: [
          { id: "ace", group: "mix", label: "Ace", short: "Ace", tone: "ace", mine: { pct: 0, rank: null, field: 8, hit: 0, att: 18 }, leaders: [], field: 8, min: 18 },
          { id: "eagle", group: "mix", label: "Eagle", short: "Eagle", tone: "eagle", mine: { pct: 5.6, rank: 4, field: 8, hit: 1, att: 18 }, leaders: [], field: 8, min: 18 },
          { id: "birdieMix", group: "mix", label: "Birdie", short: "Birdie", tone: "birdie", mine: { pct: 16.7, rank: 2, field: 8, hit: 3, att: 18 }, leaders: [], field: 8, min: 18 },
          { id: "parMix", group: "mix", label: "Par", short: "Par", tone: "par", mine: { pct: 44.4, rank: 5, field: 8, hit: 8, att: 18 }, leaders: [], field: 8, min: 18 },
          { id: "bogey", group: "mix", label: "Bogey", short: "Bogey", tone: "bogey", mine: { pct: 27.8, rank: 6, field: 8, hit: 5, att: 18 }, leaders: [], field: 8, min: 18 },
          { id: "double", group: "mix", label: "Double+", short: "Dbl+", tone: "double", mine: { pct: 5.6, rank: 3, field: 8, hit: 1, att: 18 }, leaders: [], field: 8, min: 18 },
          { id: "birdie", group: "score", label: "Birdie", mine: { pct: 16.7, rank: 2, field: 8, hit: 3, att: 18 }, leaders: [], field: 8, min: 18 },
          { id: "par", group: "score", label: "Par", mine: { pct: 44.4, rank: 5, field: 8, hit: 8, att: 18 }, leaders: [], field: 8, min: 18 },
        ],
      },
      casual: {
        mine: { memberId: "member-1", name: "QA Admin", totals: { holes: 18, eagles: 0, birdies: 6, pars: 10, bogeys: 2, doubles_plus: 0, birdie_hit: 6, par_hit: 10 } },
        categories: [
          { id: "birdieMix", group: "mix", label: "Birdie", short: "Birdie", tone: "birdie", mine: { pct: 33.3, rank: 1, field: 4, hit: 6, att: 18 }, leaders: [], field: 4, min: 18 },
        ],
      },
    }));
    if (pathName === "/shop/wallet") return route.fulfill(json({
      balance_cents: 1250,
      transactions: [{ id: "tx-1", source: "event_payout", amount_cents: 1250, note: "QA payout", created_at: "2026-07-05T12:00:00Z" }],
    }));
    if (pathName === "/my-live-rounds") return route.fulfill(json({ rounds: [] }));
    if (pathName === "/payments/config") return route.fulfill(json({ enabled: false }));
    if (pathName === "/registration/open") return route.fulfill(json({ events: openEvents }));
    if (pathName === "/pdga-registrations") return route.fulfill(json({ mine: [], club: [] }));
    if (pathName === "/my-registrations") return route.fulfill(json({ registrations: [] }));
    if (pathName === "/casual-rounds" && method === "GET") return route.fulfill(json({ requests: state.casualRequests }));
    if (pathName === "/casual-rounds" && method === "POST") {
      state.casualPostBody = JSON.parse(request.postData() || "{}");
      state.casualRequests = [postedCasualRequest(state.casualPostBody), ...state.casualRequests];
      return route.fulfill(json({ id: 77 }, 201));
    }
    if (/^\/casual-rounds\/\d+$/.test(pathName) && method === "DELETE") {
      const id = Number(pathName.split("/").pop());
      state.casualRequests = state.casualRequests.filter((row) => Number(row.id) !== id);
      return route.fulfill(json({ ok: true }));
    }
    if (pathName === "/courses") return route.fulfill(json({ courses: [{ id: 1, name: "ECU North Rec Complex" }] }));
    if (pathName === "/course-conditions") return route.fulfill(json({
      reports: [{
        id: 1,
        course_id: 1,
        course_name: "ECU North Rec Complex",
        member_name: "QA Admin",
        status: "wet",
        note: "12 is a puddle",
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }],
    }));
    if (pathName === "/courses/1/layouts") return route.fulfill(json({ layouts: [{ id: 11, name: "Pee Dee's Treasure Map" }] }));
    if (pathName === "/meetings") return route.fulfill(json({ meetings: [] }));
    if (pathName === "/board" && method === "GET") {
      return route.fulfill(json({
        posts: state.boardPosts,
        authors: {},
      }));
    }
    if (pathName === "/board" && method === "POST") {
      state.boardPostBody = JSON.parse(request.postData() || "{}");
      const post = {
        id: state.nextBoardId++,
        parent_id: state.boardPostBody.parent_id || null,
        member_id: "member-1",
        author_name: "QA Admin",
        created_at: "Jul 6, 2026",
        body: state.boardPostBody.body,
        replies: [],
      };
      if (post.parent_id) {
        const parent = state.boardPosts.find((row) => row.id === post.parent_id);
        if (parent) parent.replies = [...(parent.replies || []), post];
      } else {
        state.boardPosts = [post, ...state.boardPosts];
      }
      return route.fulfill(json({ post }, 201));
    }
    if (pathName.startsWith("/board/") && method === "DELETE") {
      const id = Number(pathName.split("/").pop());
      state.boardPosts = state.boardPosts.filter((post) => Number(post.id) !== id)
        .map((post) => ({ ...post, replies: (post.replies || []).filter((reply) => Number(reply.id) !== id) }));
      return route.fulfill(json({ ok: true }));
    }
    if (pathName === "/leagues/active") return route.fulfill(json({
      leagues: [{
        league: { id: 2, name: "GVDG QA League", season: "2026" },
        standings: [
          { name: "QA Admin", points: 8, events: 3, wins: 1 },
          { name: "Other Player", points: 6, events: 3, wins: 0 },
        ],
      }],
      events: [],
    }));
    if (pathName === "/my-tee-signs") return route.fulfill(json({ teeSigns: state.teeSigns }));
    if (pathName === "/tee-signs" && method === "POST") {
      state.teeSignPostBody = JSON.parse(request.postData() || "{}");
      const row = {
        id: state.nextTeeSignId++,
        course_id: state.teeSignPostBody.courseId,
        hole_number: state.teeSignPostBody.hole,
        r2_key: `qa/sign-${state.nextTeeSignId}.jpg`,
        content_type: "image/jpeg",
        bytes: 512,
        uploaded_by: "member-1",
        created_at: "2026-07-06T12:00:00Z",
        status: "candidate",
        extracted_json: null,
        extract_source: null,
      };
      state.teeSigns = [row, ...state.teeSigns];
      return route.fulfill(json({ teeSign: row }, 201));
    }
    if (/^\/tee-signs\/\d+\/image$/.test(pathName)) return route.fulfill(png(tinyPng));
    if (pathName.startsWith("/shop/")) return route.fulfill(json({ ok: true }));
    return route.fulfill(json({ ok: true }));
  });

  return state;
}
