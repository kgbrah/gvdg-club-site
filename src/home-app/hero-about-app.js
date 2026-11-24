import React from "react";
import { Camera, ChevronLeft, ChevronRight, CircleDollarSign, Disc3, Pause, Play } from "lucide-react";

import { safeExternalUrl } from "../shared/safe-url.js";
import { nextCircularIndex, useAnimatedCount, useRevealOnce, useSwipe } from "./interaction-hooks.js";

const h = React.createElement;

const HERO_SLIDES = 5;
const FACEBOOK_GROUP_URL = "https://www.facebook.com/groups/243452675724939";
const PHOTO_CREDIT_NAME = "TJ Braley";
const PHOTO_CREDIT_PDGA = "157256";
const PHOTO_CREDIT_URL = "https://www.pdga.com/player/157256";

const CLUB_RHYTHM = [
  { kicker: "Every week", title: "Doubles", detail: "Show up and get a card." },
  { kicker: "Every month", title: "Tournaments", detail: "Club events, all ratings." },
  { kicker: "The big one", title: "Down East Player's Cup", detail: "Biggest tournament of the year. Pros come to play." },
];

const ABOUT_PARAGRAPHS = [
  "Greenville Disc Golf Club has been putting plastic in the trees of Eastern North Carolina since 2004. Weekly doubles, monthly tournaments, and the Down East Player's Cup — the biggest tournament of the year — all live here.",
  "Scholarships for Pitt County seniors. Five local courses. First putt or rated round, there's a card for you.",
];

const ABOUT_STATS = [
  { value: 22, label: "Years Strong" },
  { value: 5, label: "Local Courses" },
  { value: 12, label: "NC Ranking" },
  { value: 7, label: "Active Leagues" },
];

const BOARD_MEMBERS = [
  { name: "Max Crotts", role: "Club Officer", icon: Disc3, founder: true },
  { name: "Adam Walter", role: "Treasurer", icon: CircleDollarSign },
  { name: "Jarrett Wallace", role: "Club Officer", icon: Disc3 },
  { name: "Jeff Stelly", role: "Club Officer", icon: Disc3 },
  { name: "TJ Braley", role: "Club Officer", icon: Disc3 },
  { name: "Alex Schwarga", role: "Club Officer", icon: Disc3 },
];

function icon(Icon, props = {}) {
  return h(Icon, {
    ...props,
    "aria-hidden": "true",
    focusable: "false",
    size: props.size || 30,
    strokeWidth: props.strokeWidth || 2.2,
  });
}

function HeroArrow({ className, label, onClick, children }) {
  return h("button", { "aria-label": label, className, onClick, type: "button" }, children);
}

function heroSlideClass(index, current, warm) {
  if (index === current) return "carousel-slide active";
  // Until the page has loaded, the slides not on screen have no picture: the first download is just the one in view.
  return warm ? "carousel-slide" : "carousel-slide carousel-slide-later";
}

function pageHasLoaded() {
  try {
    const nav = globalThis.performance?.getEntriesByType?.("navigation")?.[0];
    return Boolean(nav && nav.loadEventEnd > 0);
  } catch {
    return false;
  }
}

/** False until the page has finished loading (then the other hero slides fetch their pictures). */
function usePageLoaded() {
  const [loaded, setLoaded] = React.useState(pageHasLoaded);
  React.useEffect(() => {
    if (loaded || typeof window === "undefined") return undefined;
    const done = () => setLoaded(true);
    window.addEventListener("load", done, { once: true });
    return () => window.removeEventListener("load", done);
  }, [loaded]);
  return loaded;
}

function BoardMemberCard({ member }) {
  const className = "board-member-card" + (member.founder ? " founder" : "");
  return h("div", { className }, [
    h("div", { className: "board-member-icon", key: "icon" }, icon(member.icon, { size: 34 })),
    h("div", { className: "board-member-name", key: "name" }, member.name),
    h("div", { className: "board-member-role", key: "role" }, member.role),
  ]);
}

function RevealHeading({ children }) {
  const [ref, visible] = useRevealOnce();
  return h("h2", { className: "section-title fade-in" + (visible ? " visible" : ""), ref }, children);
}

function StatCard({ stat, index }) {
  const [ref, visible] = useRevealOnce({ delay: index * 80, threshold: 0.3 });
  const value = useAnimatedCount(stat.value, visible, 700);
  return h("div", { className: "stat-card" + (visible ? " visible" : ""), ref }, [
    h("div", { className: "stat-number", key: "value" }, String(value)),
    h("div", { className: "stat-label", key: "label" }, stat.label),
  ]);
}

export function HomeHeroSection() {
  const [current, setCurrent] = React.useState(1);
  const warm = usePageLoaded();
  const [paused, setPaused] = React.useState(false);
  const [focusPaused, setFocusPaused] = React.useState(false);
  const [manualPaused, setManualPaused] = React.useState(false);
  const swipeHandlers = useSwipe((step) => setCurrent((slide) => nextCircularIndex(slide, step, HERO_SLIDES)));
  const effectivePaused = paused || focusPaused || manualPaused;

  React.useEffect(() => {
    if (effectivePaused) return undefined;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setCurrent((slide) => nextCircularIndex(slide, 1, HERO_SLIDES));
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [effectivePaused]);

  return h("section", {
    className: "hero",
    "data-react-home-hero": "ready",
    onMouseEnter: () => setPaused(true),
    onMouseLeave: () => setPaused(false),
    onFocus: () => setFocusPaused(true),
    onBlur: (event) => {
      if (!event?.currentTarget?.contains?.(event.relatedTarget)) setFocusPaused(false);
    },
    ...swipeHandlers,
  }, [
    h("div", { className: "hero-bg-pattern", key: "pattern" }),
    h("div", { className: "carousel", key: "carousel", "aria-hidden": "true" },
      Array.from({ length: HERO_SLIDES }, (_, index) => h("div", {
        className: heroSlideClass(index, current, warm),
        key: "slide-" + index,
      }))),
    h(HeroArrow, {
      className: "carousel-arrow carousel-prev",
      key: "previous",
      label: "Previous photo",
      onClick: () => setCurrent((slide) => nextCircularIndex(slide, -1, HERO_SLIDES)),
    },
      icon(ChevronLeft, { size: 26, strokeWidth: 2.8 })),
    h(HeroArrow, {
      className: "carousel-arrow carousel-next",
      key: "next",
      label: "Next photo",
      onClick: () => setCurrent((slide) => nextCircularIndex(slide, 1, HERO_SLIDES)),
    },
      icon(ChevronRight, { size: 26, strokeWidth: 2.8 })),
    h("div", { className: "carousel-controls", key: "controls" },
      Array.from({ length: HERO_SLIDES }, (_, index) => h("button", {
        "aria-label": "Show photo " + (index + 1),
        "aria-current": index === current ? "true" : undefined,
        className: "carousel-dot" + (index === current ? " active" : ""),
        key: "dot-" + index,
        onClick: () => setCurrent(index),
        type: "button",
      }))),
    h("button", {
      "aria-label": manualPaused ? "Play hero slideshow" : "Pause hero slideshow",
      "aria-pressed": manualPaused ? "true" : "false",
      className: "carousel-pause",
      key: "pause",
      onClick: () => setManualPaused((value) => !value),
      title: manualPaused ? "Play slideshow" : "Pause slideshow",
      type: "button",
    }, h(manualPaused ? Play : Pause, { "aria-hidden": "true", size: 18 })),
    h("div", { className: "hero-content", key: "content" }, [
      h("p", { className: "hero-kicker", key: "kicker" }, "Eastern North Carolina · since 2004"),
      h("h1", { className: "hero-title", key: "title", "aria-label": "Greenville Disc Golf Club" }, [
        h("span", { className: "hero-title-line", key: "city" }, "Greenville"),
        " ",
        h("span", { className: "hero-title-line", key: "club" }, "Disc Golf Club"),
      ]),
      h("p", { className: "hero-subtitle", key: "subtitle" }, "Five courses in town. Weekly doubles. A card for your first putt or a rated round."),
      h("div", { className: "hero-actions", key: "cta" }, [
        h("a", { className: "cta-button", href: "#courses", key: "courses" }, "Where we play"),
        h("a", { className: "cta-button cta-button-ghost", href: "#membership", key: "join" }, "Join the club"),
        h("a", { className: "hero-score-link", href: "score.html", key: "score" }, "Keep score"),
      ]),
      h("div", { className: "club-rhythm", key: "rhythm", "aria-label": "How the club plays" }, [
        ...CLUB_RHYTHM.map((item) => h("div", { className: "rhythm-card", key: item.title }, [
          h("div", { className: "rhythm-kicker", key: "kicker" }, item.kicker),
          h("div", { className: "rhythm-title", key: "title" }, item.title),
          h("p", { className: "rhythm-detail", key: "detail" }, item.detail),
        ])),
        // Lost discs go through Lost & Found (the site or the app; the owner's call). The club matches them with
        // found discs and lets the owner know.
        h("a", { className: "club-group-link", href: "lost-found.html", key: "lost-found" }, [
          h("span", { key: "copy" }, "Lost a disc, or found one?"),
          h("strong", { key: "go" }, "Lost & Found"),
        ]),
        h("a", {
          className: "club-group-link",
          href: FACEBOOK_GROUP_URL,
          key: "group",
          rel: "noopener noreferrer",
          target: "_blank",
        }, [
          h("span", { key: "copy" }, "Rain calls, who's playing"),
          h("strong", { key: "go" }, "Facebook group"),
        ]),
      ]),
      h("p", {
        className: "hero-photo-credit",
        "data-home-photo-credit": "hero",
        key: "photo-credit",
      }, [
        icon(Camera, { key: "icon", size: 14, strokeWidth: 2.2 }),
        h("span", { key: "text" }, [
          `Photos by ${PHOTO_CREDIT_NAME} · `,
          h("a", {
            href: safeExternalUrl(PHOTO_CREDIT_URL),
            key: "pdga",
            rel: "noopener noreferrer",
            target: "_blank",
          }, `PDGA #${PHOTO_CREDIT_PDGA}`),
        ]),
      ]),
    ]),
  ]);
}

export function HomeAboutSection() {
  return h("div", { "data-react-home-about": "ready" }, [
    h(RevealHeading, { key: "title" }, "About Our Club"),
    h("div", { className: "about-content", key: "story" }, [
      h("div", { className: "about-text", key: "text" }, ABOUT_PARAGRAPHS.map((paragraph) => h("p", { key: paragraph }, paragraph))),
      h("div", { className: "stats-grid", key: "stats" }, ABOUT_STATS.map((stat, index) => h(StatCard, { index, key: stat.label, stat }))),
    ]),
    h("div", { className: "board-slide-header", key: "board-header" }, [
      h("h3", { className: "board-slide-title", key: "title" }, "Meet Our Board"),
      h("p", { className: "board-slide-subtitle", key: "subtitle" }, "The people who keep GVDG running"),
    ]),
    h("div", { className: "board-members-grid", key: "members" }, BOARD_MEMBERS.map((member) => h(BoardMemberCard, { member, key: member.name }))),
  ]);
}
