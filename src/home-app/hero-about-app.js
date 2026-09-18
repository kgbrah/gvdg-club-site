import React from "react";
import { ChevronLeft, ChevronRight, CircleDollarSign, Disc3 } from "lucide-react";

import { nextCircularIndex, useAnimatedCount, useRevealOnce, useSwipe } from "./interaction-hooks.js";

const h = React.createElement;

const HERO_SLIDES = 5;

const ABOUT_PARAGRAPHS = [
  "Greenville Disc Golf Club has been putting plastic in the trees of Eastern North Carolina since 2004. Weekly doubles, monthly tournaments, and the Down East Players Cup — a PDGA A-tier — all live here.",
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

function heroSlideClass(index, current) {
  return index === current ? "carousel-slide active" : "carousel-slide";
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
  const [current, setCurrent] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const swipeHandlers = useSwipe((step) => setCurrent((slide) => nextCircularIndex(slide, step, HERO_SLIDES)));

  React.useEffect(() => {
    if (paused) return undefined;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setCurrent((slide) => nextCircularIndex(slide, 1, HERO_SLIDES));
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [paused]);

  return h("section", {
    className: "hero",
    "data-react-home-hero": "ready",
    onMouseEnter: () => setPaused(true),
    onMouseLeave: () => setPaused(false),
    ...swipeHandlers,
  }, [
    h("div", { className: "hero-bg-pattern", key: "pattern" }),
    h("div", { className: "carousel", key: "carousel", "aria-hidden": "true" },
      Array.from({ length: HERO_SLIDES }, (_, index) => h("div", {
        className: heroSlideClass(index, current),
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
    h("div", { className: "hero-content", key: "content" }, [
      h("h1", { className: "hero-title", key: "title" }, "Greenville Disc Golf Club"),
      h("p", { className: "hero-subtitle", key: "subtitle" }, "Start a card on a local course. No club login."),
      h("div", { className: "hero-actions", key: "cta" }, [
        h("a", { className: "cta-button", href: "score.html", key: "score" }, "Keep score"),
        h("a", { className: "cta-button cta-button-ghost", href: "#membership", key: "join" }, "Join the Club"),
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
