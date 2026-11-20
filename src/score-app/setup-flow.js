import React from "react";
import { ArrowLeft, ChevronRight, LogOut, Navigation, PlayCircle, Search, Star } from "lucide-react";
import {
  BROWSE_MAPPED_LIMIT,
  CLUB_ORIGIN,
  COURSE_RANGE_DEFAULT,
  COURSE_RANGES,
  courseSub,
  coursesForPickScreen,
  filterCoursesForPick,
  googleMapsDirectionsUrl,
  readLastCourse,
  sortLayoutsForPick,
  teeSignCaptureHref,
} from "./course-pick.js";
import { HoleMap } from "../shared/hole-map.js";
import { safeExternalUrl } from "../shared/safe-url.js";
import { resolveApiBase } from "../shared/api-base.js";
import { courseTrafficMatch, trafficHoleLine, trafficSummary } from "../shared/course-traffic.js";
import { COVERAGE_LABELS, courseCoverage, layoutQuality, mapCoordinates } from "../shared/course-quality.js";
import { coursePackKey } from "../shared/course-packs.js";
import { ApplyForClubLogin } from "./auth-flow.js";
import { useCourseFavorites } from "./course-favorites.js";
import { coursePackDate, PackLayoutActions, SavedCoursesView, SavedLayoutPreview, useCoursePacks } from "./saved-courses-view.js";
import { AutocompleteInput } from "../shared/autocomplete.js";

const h = React.createElement;

function icon(Icon, props = {}) {
  return h(Icon, {
    key: props.key || "icon",
    size: props.size || 18,
    strokeWidth: 2.4,
    "aria-hidden": "true",
    focusable: "false",
  });
}

function BackButton({ onBack }) {
  return h(
    "button",
    { className: "btn ghost small", type: "button", onClick: onBack },
    [icon(ArrowLeft, { size: 16 }), "Back"],
  );
}

function MapBadge({ coverage, course }) {
  const label = coverage === "full" && course ? "Fully mapped layout" : COVERAGE_LABELS[coverage];
  return h("span", {
    className: coverage === "full" || coverage === "partial" ? "course-map-badge" : "course-map-badge missing",
    key: "map",
  }, label);
}

function CourseMeta({ text, coverage, course, lastPlayed, traffic }) {
  return h("div", { className: "sub-row", key: "meta" }, [
    text ? h("div", { className: "sub", key: "sub" }, text) : null,
    traffic ? h("div", { className: "sub course-traffic-sub", key: "traffic" }, traffic) : null,
    lastPlayed ? h("span", { className: "course-map-badge last", key: "last" }, "Last played") : null,
    h(MapBadge, { key: "map", coverage, course }),
  ]);
}

function DirectionsLink({ course, origin }) {
  const href = safeExternalUrl(googleMapsDirectionsUrl(course, origin));
  if (!href) return null;
  return h(
    "a",
    {
      className: "course-directions",
      href,
      target: "_blank",
      rel: "noopener noreferrer",
      key: "directions",
      "aria-label": `Directions to ${course.name}`,
      title: "Directions",
      onClick: (event) => event.stopPropagation(),
    },
    icon(Navigation, { size: 18, key: "nav" }),
  );
}

const RECENT_ROUNDS_KEY = "gvdg_recent_rounds";

function readRecentRounds() {
  try {
    const rows = JSON.parse(localStorage.getItem(RECENT_ROUNDS_KEY) || "[]");
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      code: String(row && row.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      label: String(row && row.label || "").trim(),
    })).filter((row) => {
      if (row.code.length < 4 || seen.has(row.code)) return false;
      seen.add(row.code);
      return true;
    }).slice(0, 4);
  } catch {
    return [];
  }
}

function HomeView({ onStart, onJoin, onInvalidCode, onSignOut, onSignIn, onWatch, signedIn, playerName }) {
  const [joinCode, setJoinCode] = React.useState("");
  const [showSaved, setShowSaved] = React.useState(false);
  const submitJoin = () => {
    const code = joinCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length >= 4) onJoin(code);
    else onInvalidCode();
  };
  const recent = readRecentRounds();
  if (showSaved) return h(SavedCoursesView, { onBack: () => setShowSaved(false) });

  return h("div", { className: "stack" }, [
    h("div", { className: "card stack", key: "card" }, [
      h("h2", { className: "section", key: "title" }, "Keep score"),
      h(
        "p",
        { className: "muted", key: "copy" },
        signedIn
          ? "Start a casual round and share the code with your card, or join a round someone already started."
          : "No club login needed. Start a card, share the code, or join one already going.",
      ),
      signedIn ? null : h(ApplyForClubLogin, { className: "btn secondary", key: "apply" }),
      playerName && !signedIn
        ? h("p", { className: "muted", key: "who" }, "Playing as " + playerName + ".")
        : null,
      h(
        "button",
        { className: "btn", type: "button", onClick: onStart, key: "start" },
        [icon(PlayCircle), "Start a casual round"],
      ),
      h("button", { className: "btn secondary", type: "button", key: "saved", onClick: () => setShowSaved(true) }, "Saved course layouts"),
      h("a", { className: "btn secondary", href: "score.html?offline=1", key: "offline" }, "Offline rounds"),
      h("label", { className: "lbl", htmlFor: "joinRoundCode", key: "joinLabel" }, "Join with a code"),
      h("input", {
        className: "field",
        id: "joinRoundCode",
        key: "joinInput",
        value: joinCode,
        placeholder: "e.g. K7M2QX",
        autoCapitalize: "characters",
        maxLength: 12,
        onChange: (event) => setJoinCode(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") submitJoin();
        },
      }),
      h(
        "button",
        { className: "btn secondary", type: "button", onClick: submitJoin, key: "joinButton" },
        "Join round",
      ),
      h(
        "button",
        { className: "btn ghost", type: "button", onClick: () => (joinCode.trim() ? onWatch(joinCode) : onInvalidCode()), key: "watchButton" },
        "Watch this round",
      ),
      recent.length
        ? h("div", { className: "stack", key: "recent" }, [
          h("p", { className: "lbl", key: "label" }, "Jump back in"),
          ...recent.map((row) => h("button", {
            className: "tap-row",
            key: row.code,
            type: "button",
            onClick: () => onJoin(row.code),
          }, [
            h("div", { className: "grow", key: "copy" }, [
              h("div", { className: "title", key: "title" }, row.label && row.label !== row.code ? row.label : "Casual round"),
              h("div", { className: "muted", key: "code" }, row.code),
            ]),
            h("div", { className: "chev", key: "chev" }, "Rejoin"),
          ])),
        ])
        : null,
    ]),
    signedIn
      ? h(
          "button",
          { className: "btn ghost", type: "button", onClick: onSignOut, key: "signOut" },
          [icon(LogOut), "Sign out"],
        )
      : h(
          "button",
          { className: "btn ghost", type: "button", onClick: onSignIn, key: "signIn" },
          "Sign in with a club account",
        ),
  ]);
}

function useDeviceOrigin() {
  const [state, setState] = React.useState({ origin: null, status: "idle" });
  const request = React.useRef(0);
  React.useEffect(() => () => { request.current += 1; }, []);
  function locate() {
    const id = ++request.current;
    if (!navigator.geolocation) {
      setState({ origin: null, status: "unavailable" });
      return;
    }
    setState({ origin: null, status: "loading" });
    navigator.geolocation.getCurrentPosition((position) => {
      if (id !== request.current) return;
      const origin = mapCoordinates({ lat: position.coords?.latitude, lng: position.coords?.longitude });
      setState({ origin, status: origin ? "ready" : "unavailable" });
    }, () => {
      if (id === request.current) setState({ origin: null, status: "unavailable" });
    }, { enableHighAccuracy: false, maximumAge: 120000, timeout: 10000 });
  }
  const reset = () => {
    request.current += 1;
    setState({ origin: null, status: "idle" });
  };
  return { ...state, locate, reset };
}

function useOnlineStatus() {
  const [online, setOnline] = React.useState(() => globalThis.navigator?.onLine !== false);
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function useCourseTraffic() {
  const [courses, setCourses] = React.useState([]);
  React.useEffect(() => {
    const base = resolveApiBase({ datasetKeys: ["apiBase"] });
    let dead = false;
    let timer = 0;
    function load() {
      fetch(base + "/course-traffic", { cache: "no-store", headers: { Accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : { courses: [] }))
        .then((data) => {
          if (!dead) setCourses(Array.isArray(data && data.courses) ? data.courses : []);
        })
        .catch(() => {});
    }
    load();
    timer = window.setInterval(load, 45000);
    return () => {
      dead = true;
      window.clearInterval(timer);
    };
  }, []);
  return courses;
}

function CoursePickView({ courses, onBack, onSelect }) {
  const [query, setQuery] = React.useState("");
  const [range, setRange] = React.useState(COURSE_RANGE_DEFAULT);
  const [rangeTouched, setRangeTouched] = React.useState(false);
  const [coverage, setCoverage] = React.useState("");
  const [favoritesOnly, setFavoritesOnly] = React.useState(false);
  const [savedOnly, setSavedOnly] = React.useState(false);
  const device = useDeviceOrigin();
  const online = useOnlineStatus();
  const favoriteState = useCourseFavorites();
  const { packs } = useCoursePacks();
  const [showSaved, setShowSaved] = React.useState(false);
  const lastPlayed = React.useMemo(() => readLastCourse(), []);
  const traffic = useCourseTraffic();
  const savedIds = new Set(packs.map((pack) => String(pack.course.id)));
  const browsing = !query.trim();
  const sortOrigin = device.origin || CLUB_ORIGIN;
  const filterOptions = { coverage, favoritesOnly, favoriteIds: favoriteState.favorites, savedOnly, savedIds };
  const filtered = coursesForPickScreen(courses, query, range, sortOrigin, {
    ...filterOptions, lastCourseId: browsing ? lastPlayed?.id : null,
  });
  const hidden = browsing && range !== "all" && filterCoursesForPick(courses, "", range, sortOrigin, filterOptions).length > filtered.length;

  function onQuery(value) {
    setQuery(value);
    if (!rangeTouched) setRange(value.trim() ? "all" : COURSE_RANGE_DEFAULT);
  }
  function toggleList(set, current) {
    set(!current);
    if (!current && !rangeTouched) setRange("all");
  }
  if (showSaved) return h(SavedCoursesView, { onBack: () => setShowSaved(false) });
  return h("div", { className: "stack" }, [
    h(BackButton, { onBack, key: "back" }),
    h("h2", { className: "section", key: "title" }, "Pick a course"),
    traffic.length
      ? h("div", { className: "card stack", "data-course-traffic": "ready", key: "traffic" }, [
        h("h3", { className: "section", key: "label" }, "On a course now"),
        h("p", { className: "muted", key: "copy" }, "Live groups, hole by hole, from cards scoring in the app."),
        ...traffic.map((row) => h("p", { className: "muted", key: row.courseId || row.name }, [
          h("strong", { key: "name" }, row.name),
          " — " + trafficSummary(row),
          trafficHoleLine(row) ? h("span", { key: "holes" }, "  " + trafficHoleLine(row)) : null,
        ])),
      ])
      : null,
    h("div", { className: "course-filters", key: "filters" }, [
    h("label", { className: "lbl", htmlFor: "courseSearch", key: "searchLabel" }, "Search"),
    h("div", { className: "course-search", key: "search" }, [
      icon(Search, { size: 16, key: "icon" }),
      // Course names autocomplete (with their town); the list below still filters as you type.
      h(AutocompleteInput, {
        suggestions: (courses || []).filter((course) => course?.name).map((course) => ({
          label: course.name, value: course.name, hint: course.location || "", key: "course-" + course.id,
        })),
        wrapperClassName: "course-search-ac",
        className: "field",
        id: "courseSearch",
        key: "input",
        value: query,
        placeholder: "Course name, city, or layout",
        enterKeyHint: "search",
        onChange: (event) => onQuery(event.target.value),
      }),
    ]),
    h("div", { className: "course-map-holes", key: "tools" }, [
      h("button", { className: "btn ghost small", type: "button", key: "near", "aria-pressed": Boolean(device.origin),
        disabled: device.status === "loading", onClick: device.origin ? device.reset : device.locate },
        device.status === "loading" ? "Finding location…" : device.origin ? "Use Greenville instead" : "Use my location"),
      favoriteState.available ? h("button", { className: "btn ghost small", key: "favorites", type: "button",
        "aria-pressed": favoritesOnly, onClick: () => toggleList(setFavoritesOnly, favoritesOnly) }, "Favorites") : null,
      h("button", { className: "btn ghost small", key: "saved", type: "button", onClick: () => setShowSaved(true) }, "Saved layouts"),
      online && packs.length ? h("button", { className: "btn ghost small", key: "savedOnly", type: "button",
        "aria-pressed": savedOnly, onClick: () => toggleList(setSavedOnly, savedOnly) }, "Courses with downloads") : null,
    ]),
    device.status === "unavailable" ? h("p", { key: "location", className: "muted", role: "status" }, "Location unavailable. Showing distances from Greenville.") : null,
    favoriteState.error ? h("p", { key: "favoriteError", className: "muted", role: "status" }, favoriteState.error) : null,
    h("label", { className: "lbl", key: "coverage" }, "Map coverage",
      h("select", { className: "field", value: coverage, onChange: (event) => setCoverage(event.target.value) }, [
        h("option", { key: "all", value: "" }, "Any coverage"),
        ...Object.entries(COVERAGE_LABELS).reverse().map(([id, label]) => h("option", { key: id, value: id }, label)),
      ])),
    h("div", { className: "course-range", key: "range" }, [
      h("label", { className: "lbl", htmlFor: "courseRadius", key: "radiusLabel" }, device.origin ? "Radius from your location" : "Radius from Greenville"),
      h(
        "select",
        {
          className: "field",
          id: "courseRadius",
          key: "radius",
          value: range,
          "aria-label": "Search radius",
          onChange: (event) => {
            setRangeTouched(true);
            setRange(event.target.value);
          },
        },
        COURSE_RANGES.map((option) =>
          h("option", { key: option.value, value: option.value }, option.label),
        ),
      ),
    ]),
    ]),
    h("p", { className: "muted", key: "count" }, !online && !filtered.length ? "The course catalog needs a connection. You can open your saved layouts." :
      filtered.length ? filtered.length + " course" + (filtered.length === 1 ? "" : "s") +
        (hidden ? " · Showing up to " + BROWSE_MAPPED_LIMIT + " nearby mapped courses. Choose All courses to browse more." : "") : "No courses match your filters."),
    filtered.length
      ? filtered.map((course) => {
          const level = courseCoverage(course);
          const favorite = favoriteState.favorites.has(String(course.id));
          const last = lastPlayed && String(lastPlayed.id) === String(course.id);
          const live = courseTrafficMatch(traffic, course);
          const updated = Array.isArray(course.layouts) ? coursePackDate(course.layouts.map((layout) => layout.updated_at).filter(Boolean).sort().at(-1)) : "";
          return h(
            "div",
            { className: "tap-row", key: course.id || course.name },
            [
              h(
                "button",
                { className: "tap-row-main", type: "button", onClick: () => onSelect(course), key: "select" },
                [
                  h("div", { className: "grow", key: "content" }, [
                    h("div", { className: "title", key: "title" }, course.name),
                    h(CourseMeta, { text: [courseSub(course, sortOrigin), updated ? "Layout updated " + updated : ""].filter(Boolean).join(" · "),
                      coverage: level, course: true, lastPlayed: last, traffic: live ? trafficSummary(live) : "", key: "meta" }),
                  ]),
                  h("div", { className: "chev", key: "chev" }, icon(ChevronRight)),
                ],
              ),
              favoriteState.available ? h("button", { className: "course-directions", key: "favorite", type: "button",
                disabled: favoriteState.loading || Boolean(favoriteState.busy), "aria-pressed": favorite,
                "aria-label": (favorite ? "Remove " : "Add ") + course.name + (favorite ? " from favorites" : " to favorites"),
                title: favorite ? "Remove favorite" : "Add favorite",
                onClick: () => favoriteState.toggle(course.id),
              }, h(Star, { size: 18, fill: favorite ? "currentColor" : "none", "aria-hidden": true })) : null,
              level !== "full" ? h("a", { className: "course-map-capture", key: "capture", href: teeSignCaptureHref(course) }, "Add a map") : null,
              h(DirectionsLink, { course, origin: sortOrigin, key: "dir" }),
            ],
          );
        })
      : null,
    h("p", { className: "muted", key: "attr" }, "Course list includes DiscGolfAPI data."),
  ]);
}

const MISSING_LAYOUT_LABELS = {
  tee: "tee", basket: "basket", par: "par", "confirmed-par": "confirmed par", "distinct-positions": "separate tee and basket positions",
};

function LayoutCoverageDetails({ layout, quality }) {
  const missing = quality.holes.filter((hole) => hole.missing.length);
  const updated = [layout.updated_at, layout.map_updated_at].filter(Boolean).sort().at(-1);
  const date = coursePackDate(updated || layout.created_at);
  return h("div", { className: "stack" }, [
    h("p", { className: "muted", key: "summary" }, [
      quality.mappedCount + " of " + quality.holeCount + " layout holes have a tee and basket.",
      quality.placeholderPars ? " " + quality.placeholderPars + " placeholder " + (quality.placeholderPars === 1 ? "par." : "pars.") : "",
      quality.teeSignPars ? " " + quality.teeSignPars + " " + (quality.teeSignPars === 1 ? "par is" : "pars are") + " approved from tee signs." : "",
      date ? " " + (updated ? "Layout data updated " : "Layout record added ") + date + "." : "",
    ].join("")),
    missing.length || quality.invalidRows || quality.unlistedHoles ? h("details", { key: "gaps" }, [
      h("summary", { key: "heading" }, "Missing hole data"),
      h("ul", { key: "gaps" }, [
        ...missing.map((hole) => h("li", { key: hole.hole }, "Hole " + hole.hole + " needs " + hole.missing.map((key) => MISSING_LAYOUT_LABELS[key]).join(", "))),
        quality.invalidRows ? h("li", { key: "invalid" }, quality.invalidRows + " invalid or duplicate hole records") : null,
        quality.unlistedHoles ? h("li", { key: "unlisted" }, quality.unlistedHoles + " expected holes are missing from the layout") : null,
      ]),
    ]) : null,
  ]);
}

function LayoutPickView({ course, layouts, onBack, onSelect }) {
  const sorted = sortLayoutsForPick(layouts);
  const { packs, refresh } = useCoursePacks();
  const [savedPreview, setSavedPreview] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [query, setQuery] = React.useState("");
  const online = useOnlineStatus();
  const coursePacks = packs.filter((pack) => String(pack.course.id) === String(course.id));
  const visible = sorted.filter((layout) => String(layout.name || "").toLowerCase().includes(query.trim().toLowerCase()));
  const catalogIds = new Set(sorted.map((layout) => coursePackKey(course.id, layout.id)));
  if (savedPreview) return h(SavedLayoutPreview, { pack: savedPreview, key: savedPreview.key, onBack: () => setSavedPreview(null) });
  return h("div", { className: "stack" }, [
    h(BackButton, { onBack, key: "back" }),
    h("h2", { className: "section", key: "title" }, course.name),
    h("label", { className: "lbl", key: "search" }, "Search layouts",
      h(AutocompleteInput, { className: "field", placeholder: "Layout name", type: "search", value: query,
        suggestions: sorted.map((layout) => String(layout.name || "")).filter(Boolean),
        onChange: (event) => setQuery(event.target.value) })),
    !online ? h("p", { className: "muted", key: "offline" }, "You can view saved layouts offline. Starting a round here needs a connection.") : null,
    h("p", { className: "muted", key: "packInfo" }, "Offline saves include available hole data and schematic maps."),
    h("p", { className: "muted", key: "status", role: "status" }, status),
    ...visible.map((layout) => {
      const quality = layoutQuality(layout);
      const pack = coursePacks.find((row) => row.key === coursePackKey(course.id, layout.id));
      return h("section", { className: "card stack", key: layout.id || layout.name }, [
        h("button", {
          className: "tap-row", type: "button", onClick: () => onSelect(layout), key: "start",
          disabled: !online || !quality.scorable, "aria-label": "Choose " + (layout.name || "Layout"),
        }, [
          h("div", { className: "grow", key: "content" }, [
            h("div", { className: "title", key: "title" }, layout.name || "Layout"),
            h(CourseMeta, { key: "meta", coverage: quality.status,
              text: layout.total_par != null ? (quality.placeholderPars ? "Estimated par " : "Par ") + layout.total_par : "" }),
          ]),
          h("div", { className: "chev", key: "chev" }, icon(ChevronRight)),
        ]),
        h(LayoutCoverageDetails, { key: "details", layout, quality }),
        h(PackLayoutActions, { key: "pack", course, layout, pack, refresh, busy, onBusy: setBusy,
          onOpen: setSavedPreview, onStatus: setStatus, allowSave: quality.holes.length > 0 }),
      ]);
    }),
    ...coursePacks.filter((pack) => !catalogIds.has(pack.key) && pack.layout.name.toLowerCase().includes(query.trim().toLowerCase())).map((pack) =>
      h("section", { className: "card stack", key: pack.key }, [
        h("h3", { key: "title" }, pack.layout.name),
        h(PackLayoutActions, { key: "pack", course, layout: pack.layout, pack, refresh, busy,
          onBusy: setBusy, onOpen: setSavedPreview, onStatus: setStatus }),
      ])),
    !visible.length && !coursePacks.length ? h("p", { className: "muted", key: "empty" },
      query.trim() ? "No layouts match your search." : "No layouts are available. An admin can add one from the layout editor.") : null,
    sorted.some((layout) => layoutQuality(layout).status !== "full") ?
      h("a", { className: "btn secondary", href: teeSignCaptureHref(course), key: "capture" }, "Capture a tee sign") : null,
  ]);
}

const OPTION_GROUPS = [
  {
    key: "groupFormat",
    label: "Group format",
    attr: "data-group-format",
    options: [
      { value: "singles", title: "Singles", sub: "One score per player" },
      { value: "doubles", title: "Doubles", sub: "One score per pair" },
    ],
  },
  {
    key: "scoringStyle",
    label: "Scoring style",
    attr: "data-scoring-style",
    options: [
      { value: "stroke", title: "Stroke play", sub: "Lowest total wins" },
      { value: "matchplay", title: "Match play", sub: "Win holes head to head" },
    ],
  },
];

function SetupPickView({ layout, defaultConfig, notice, onBack, onCreate }) {
  const [selected, setSelected] = React.useState(defaultConfig);
  const [code, setCode] = React.useState("");

  return h("div", { className: "stack" }, [
    h(BackButton, { onBack, key: "back" }),
    h("div", { className: "card stack", "data-score-setup": "casual-format", key: "intro" }, [
      h("span", { className: "pill", key: "pill" }, layout && layout.name ? layout.name : "Layout"),
      h("h2", { className: "section", key: "title" }, "Round setup"),
      h(
        "p",
        { className: "muted", key: "copy" },
        "Choose how this casual card is scored. Defaults are ready for a standard singles stroke round.",
      ),
    ]),
    ...OPTION_GROUPS.map((group) =>
      h("div", { className: "card stack", key: group.key }, [
        h("label", { className: "lbl", key: "label" }, group.label),
        h(
          "div",
          { className: "setup-grid", key: "grid" },
          group.options.map((option) => {
            const pressed = selected[group.key] === option.value;
            return h(
              "button",
              {
                className: "setup-option",
                type: "button",
                key: option.value,
                "aria-pressed": pressed ? "true" : "false",
                [group.attr]: option.value,
                onClick: () => setSelected((current) => {
                  const next = { ...current, [group.key]: option.value };
                  if (group.key === "scoringStyle" && option.value === "matchplay") next.handicap = false;
                  return next;
                }),
              },
              [
                h("span", { className: "title", key: "title" }, option.title),
                h("span", { className: "sub", key: "sub" }, option.sub),
              ],
            );
          }),
        ),
      ]),
    ),
    h("div", { className: "card stack", key: "handicap" }, [
      h("label", { className: "lbl", key: "label" }, "Handicap scoring"),
      h("div", { className: "setup-grid", key: "grid" }, [
        ["off", "Off", "Rank this round as shot"],
        ["on", "On", "Rank start plus this round"],
      ].map(([value, title, sub]) => {
        const stroke = selected.scoringStyle !== "matchplay";
        const on = stroke && selected.handicap === true;
        const pressed = value === "on" ? on : !on;
        return h("button", {
          "aria-pressed": pressed ? "true" : "false",
          className: "setup-option",
          "data-handicap": value,
          disabled: !stroke && value === "on",
          key: value,
          type: "button",
          onClick: () => setSelected((current) => ({ ...current, handicap: value === "on" && current.scoringStyle !== "matchplay" })),
        }, [
          h("span", { className: "title", key: "title" }, title),
          h("span", { className: "sub", key: "sub" }, sub),
        ]);
      })),
      selected.scoringStyle === "matchplay"
        ? h("p", { className: "muted", key: "note" }, "Match play stays head to head. Handicap is for stroke play.")
        : h("p", { className: "muted", key: "note" }, "Off by default. Turn it on to rank this card with club handicaps."),
    ]),
    h("div", { className: "card stack", key: "code" }, [
      h("label", { className: "lbl", htmlFor: "roundCode", key: "label" }, "Scoring invite code"),
      h("input", {
        autoCapitalize: "characters",
        className: "field",
        id: "roundCode",
        key: "input",
        maxLength: 12,
        placeholder: "Optional, like SATURDAY",
        value: code,
        onChange: (event) => setCode(event.target.value),
      }),
      h("p", { className: "muted", key: "hint" }, "Leave it blank and we'll make one. 4–12 letters or numbers. New rounds start as Card only. Use Round tools to share a watch link."),
      notice ? h("p", { className: "muted", key: "notice", role: "alert" }, notice) : null,
    ]),
    h(
      "button",
      {
        className: "btn",
        type: "button",
        "data-create-round": "casual",
        onClick: () => onCreate({ ...selected, code }),
        key: "create",
      },
      "Start round",
    ),
  ]);
}

function CourseMapView({ course, holes, holeIndex, layout, missing, onBack, onHole, onStart }) {
  const hole = holes[holeIndex] || null;
  return h("div", { className: "stack" }, [
    h(BackButton, { onBack, key: "back" }),
    h("h2", { className: "section", key: "title" }, course && course.name ? course.name : "Course map"),
    h("p", { className: "muted", key: "layout" }, layout && layout.name ? layout.name : "Club hole map"),
    missing
      ? h("p", { className: "muted", key: "missing" }, "This course has no hole map in the club app yet. You can still start a round.")
      : h(HoleMap, { hole, key: "map", layoutId: layout && (layout.id || layout.layout_id) }),
    holes.length
      ? h("div", { className: "course-map-holes", key: "holes" }, holes.map((row, index) => h("button", {
        className: "watch-hole-chip" + (index === holeIndex ? " on" : ""),
        key: row.hole,
        type: "button",
        onClick: () => onHole(index),
      }, String(row.hole))))
      : null,
    h("button", { className: "btn", key: "start", type: "button", onClick: onStart }, "Start a round here"),
  ]);
}

export function ScoreSetupFlow(props) {
  switch (props.view) {
    case "home":
      return h(HomeView, props);
    case "coursePick":
      return h(CoursePickView, props);
    case "courseMap":
      return h(CourseMapView, props);
    case "layoutPick":
      return h(LayoutPickView, props);
    case "setupPick":
      return h(SetupPickView, props);
    default:
      return null;
  }
}
