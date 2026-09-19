import React from "react";
import { ArrowLeft, ChevronRight, LogOut, PlayCircle, Search } from "lucide-react";
import {
  COURSE_RANGES,
  courseHasMap,
  courseSub,
  filterCoursesForPick,
  layoutHasMap,
  sortLayoutsForPick,
} from "./course-pick.js";

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

function MapBadge() {
  return h("span", { className: "course-map-badge", key: "map" }, "Mapped");
}

function HomeView({ onStart, onJoin, onInvalidCode, onSignOut, onSignIn, onWatch, signedIn, playerName }) {
  const [joinCode, setJoinCode] = React.useState("");
  const submitJoin = () => {
    const code = joinCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length >= 4) onJoin(code);
    else onInvalidCode();
  };

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
      playerName && !signedIn
        ? h("p", { className: "muted", key: "who" }, "Playing as " + playerName + ".")
        : null,
      h(
        "button",
        { className: "btn", type: "button", onClick: onStart, key: "start" },
        [icon(PlayCircle), "Start a casual round"],
      ),
      h("label", { className: "lbl", htmlFor: "joinRoundCode", key: "joinLabel" }, "Join with a code"),
      h("input", {
        className: "field",
        id: "joinRoundCode",
        key: "joinInput",
        value: joinCode,
        placeholder: "e.g. K7M2QX",
        autoCapitalize: "characters",
        maxLength: 8,
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

function CoursePickView({ courses, onBack, onSelect }) {
  const [query, setQuery] = React.useState("");
  const [range, setRange] = React.useState("nearby");
  const filtered = filterCoursesForPick(courses, query, range);
  const mappedCount = filtered.filter(courseHasMap).length;

  return h("div", { className: "stack" }, [
    h(BackButton, { onBack, key: "back" }),
    h("h2", { className: "section", key: "title" }, "Pick a course"),
    h("label", { className: "lbl", htmlFor: "courseSearch", key: "searchLabel" }, "Search"),
    h("div", { className: "course-search", key: "search" }, [
      icon(Search, { size: 16, key: "icon" }),
      h("input", {
        className: "field",
        id: "courseSearch",
        key: "input",
        value: query,
        placeholder: "Name or city",
        onChange: (event) => setQuery(event.target.value),
      }),
    ]),
    h(
      "div",
      { className: "course-range", key: "range", role: "group", "aria-label": "Distance" },
      COURSE_RANGES.map((option) =>
        h(
          "button",
          {
            className: range === option.value ? "btn small" : "btn ghost small",
            type: "button",
            key: option.value,
            "aria-pressed": range === option.value ? "true" : "false",
            onClick: () => setRange(option.value),
          },
          option.label,
        ),
      ),
    ),
    h(
      "p",
      { className: "muted", key: "count" },
      filtered.length
        ? `${filtered.length} course${filtered.length === 1 ? "" : "s"}${mappedCount ? ` · ${mappedCount} mapped` : ""} · maps first, then nearest`
        : "No courses match that search.",
    ),
    filtered.length
      ? filtered.map((course) =>
          h(
            "button",
            { className: "tap-row", type: "button", key: course.id || course.name, onClick: () => onSelect(course) },
            [
              h("div", { className: "grow", key: "content" }, [
                h("div", { className: "title-row", key: "title-row" }, [
                  h("div", { className: "title", key: "title" }, course.name),
                  courseHasMap(course) ? h(MapBadge) : null,
                ]),
                h("div", { className: "sub", key: "sub" }, courseSub(course)),
              ]),
              h("div", { className: "chev", key: "chev" }, icon(ChevronRight)),
            ],
          ),
        )
      : null,
    h("p", { className: "muted", key: "attr" }, "Course list includes DiscGolfAPI data."),
  ]);
}

function LayoutPickView({ course, layouts, onBack, onSelect }) {
  const sorted = sortLayoutsForPick(layouts);
  return h("div", { className: "stack" }, [
    h(BackButton, { onBack, key: "back" }),
    h("h2", { className: "section", key: "title" }, course.name),
    sorted.length
      ? sorted.map((layout) =>
          h(
            "button",
            { className: "tap-row", type: "button", key: layout.id || layout.name, onClick: () => onSelect(layout) },
            [
              h("div", { className: "grow", key: "content" }, [
                h("div", { className: "title-row", key: "title-row" }, [
                  h("div", { className: "title", key: "title" }, layout.name || "Layout"),
                  layoutHasMap(layout) ? h(MapBadge) : null,
                ]),
                h("div", { className: "sub", key: "sub" }, layout.total_par != null ? `Par ${layout.total_par}` : ""),
              ]),
              h("div", { className: "chev", key: "chev" }, icon(ChevronRight)),
            ],
          ),
        )
      : h(
          "p",
          { className: "muted", key: "empty" },
          "This course has no scorable layouts yet - an admin can add one from Admin > Layouts, or import from UDisc.",
        ),
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

function SetupPickView({ layout, defaultConfig, onBack, onCreate }) {
  const [selected, setSelected] = React.useState(defaultConfig);

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
                onClick: () => setSelected((current) => ({ ...current, [group.key]: option.value })),
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
    h(
      "button",
      {
        className: "btn",
        type: "button",
        "data-create-round": "casual",
        onClick: () => onCreate(selected),
        key: "create",
      },
      "Start round",
    ),
  ]);
}

export function ScoreSetupFlow(props) {
  switch (props.view) {
    case "home":
      return h(HomeView, props);
    case "coursePick":
      return h(CoursePickView, props);
    case "layoutPick":
      return h(LayoutPickView, props);
    case "setupPick":
      return h(SetupPickView, props);
    default:
      return null;
  }
}
