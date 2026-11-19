import React from "react";
import { ArrowUpRight, Crosshair, Disc3, Palette, Radio, ShoppingBag, Trophy } from "lucide-react";

const h = React.createElement;

const FEATURES = [
  {
    title: "Score + watch live",
    description: "Keep score on a hole map, film throw clips, and share a watch link. No spectator login.",
    icon: Radio,
  },
  {
    title: "Stats + club ranks",
    description: "Marked-lie stats, sample counts, and member ranks by category.",
    icon: Crosshair,
  },
  {
    title: "Lost & Found",
    description: "Found a disc, or lost one? Post it from the hole. The club matches it and gets it home.",
    icon: Disc3,
  },
  {
    title: "PDGA, built in",
    description: "Your official rating, nearby PDGA events, sign-up for the club's PDGA events, and one-tap renewal.",
    icon: Trophy,
  },
  {
    title: "My Bag + marketplace",
    description: "Private photos of every disc you carry. Buy, sell, and trade gear with club members.",
    icon: ShoppingBag,
  },
  {
    title: "Customize your app",
    description: "Custom wallpapers, photo-inspired palettes, and your own disc color.",
    icon: Palette,
  },
];

export function HomeScoringTeaser() {
  return h("section", {
    id: "scoring-app-teaser",
    "aria-labelledby": "scoring-teaser-title",
    "data-react-home-scoring-teaser": "ready",
  }, [
    h("div", { className: "scoring-teaser-copy", key: "copy" }, [
      h("p", { className: "scoring-teaser-kicker", key: "kicker" }, "The GVDG club app"),
      h("h2", { id: "scoring-teaser-title", key: "title" }, "Your round. Your way."),
      h("p", { className: "scoring-teaser-description", key: "description" }, "Keep score, find lost discs, sign up for events, and keep up with your PDGA game. All in your browser."),
      h("div", { className: "scoring-teaser-actions", key: "actions" }, [
        h("a", { className: "scoring-teaser-explore", href: "scoring-app.html", key: "explore" }, [
          "Explore the app",
          h(ArrowUpRight, { "aria-hidden": "true", focusable: "false", size: 18, key: "arrow" }),
        ]),
        h("a", { className: "scoring-teaser-score", href: "score.html", key: "score" }, "Keep score"),
      ]),
    ]),
    h("ul", { className: "scoring-teaser-features", key: "features" }, FEATURES.map((feature) => h("li", { key: feature.title }, [
      h("span", { className: "scoring-teaser-icon", key: "icon" }, h(feature.icon, { "aria-hidden": "true", focusable: "false", size: 22 })),
      h("div", { key: "text" }, [
        h("h3", { key: "title" }, feature.title),
        h("p", { key: "description" }, feature.description),
      ]),
    ]))),
  ]);
}
