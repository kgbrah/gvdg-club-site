const stats = {
  pdga: "90000001",
  name: "GVDG QA Dashboard",
  official_rating: 935,
  rating_date: "2026-07-01",
  live_rating: 941,
  peak_rating: 958,
  events_count: 2,
  events: [
    {
      tournament: "GVDG QA Summer Check",
      date: "Jul 4 2026",
      epoch: 1783123200,
      division: "MA2",
      rounds: [
        { rating: 943, score: 54, round: "1" },
        { rating: 951, score: 52, round: "2" },
      ],
    },
  ],
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
      },
    ],
  },
  casual: {
    live_rating: 890,
    rated_rounds: 1,
    rounds_count: 1,
    rounds: [
      {
        id: 202,
        label: "ECU North Rec Complex - Pee Dee's Treasure Map",
        date: "2026-07-05T14:00:00Z",
        total: 58,
        to_par: 4,
        rating: 890,
        rating_source: "estimated",
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

function json(body, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
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

export async function installMemberDashboardApiRoutes(page, apiBase) {
  const state = {
    casualPostBody: null,
    casualRequests: [initialCasualRequest()],
  };

  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathName = url.pathname;
    const method = request.method();

    if (pathName === "/me") return route.fulfill(json({ sub: "member-1", isAdmin: true, name: "QA Admin", pdgaNo: "90000001" }));
    if (pathName === "/pdga-stats") return route.fulfill(json(stats));
    if (pathName.startsWith("/my-ratings")) return route.fulfill(json(myRatings));
    if (pathName === "/shop/wallet") return route.fulfill(json({
      balance_cents: 1250,
      transactions: [{ id: "tx-1", source: "event_payout", amount_cents: 1250, note: "QA payout", created_at: "2026-07-05T12:00:00Z" }],
    }));
    if (pathName === "/my-live-rounds") return route.fulfill(json({ rounds: [] }));
    if (pathName === "/payments/config") return route.fulfill(json({ enabled: false }));
    if (pathName === "/registration/open") return route.fulfill(json({ events: openEvents }));
    if (pathName === "/my-registrations") return route.fulfill(json({ registrations: [] }));
    if (pathName === "/casual-rounds" && method === "GET") return route.fulfill(json({ requests: state.casualRequests }));
    if (pathName === "/casual-rounds" && method === "POST") {
      state.casualPostBody = JSON.parse(request.postData() || "{}");
      state.casualRequests = [postedCasualRequest(state.casualPostBody), ...state.casualRequests];
      return route.fulfill(json({ id: 77 }, 201));
    }
    if (pathName === "/courses") return route.fulfill(json({ courses: [{ id: 1, name: "ECU North Rec Complex" }] }));
    if (pathName === "/courses/1/layouts") return route.fulfill(json({ layouts: [{ id: 11, name: "Pee Dee's Treasure Map" }] }));
    if (pathName === "/meetings") return route.fulfill(json({ meetings: [] }));
    if (pathName === "/board") return route.fulfill(json({ posts: [], authors: {} }));
    if (pathName === "/leagues/active") return route.fulfill(json({ leagues: [], events: [] }));
    if (pathName === "/my-tee-signs") return route.fulfill(json({ teeSigns: [] }));
    if (pathName.startsWith("/shop/")) return route.fulfill(json({ ok: true }));
    return route.fulfill(json({ ok: true }));
  });

  return state;
}
