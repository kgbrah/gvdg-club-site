import React from "react";
import { ArrowUpRight, Crosshair, Palette, Radio, Video } from "lucide-react";

const h = React.createElement;

const FEATURES = [
  {
    title: "Stats + club ranks",
    description: "Marked-lie stats, sample counts, and member ranks by category.",
    icon: Crosshair,
  },
  {
    title: "Customize your app",
    description: "Custom wallpapers, photo-inspired palettes, and your own disc color.",
    icon: Palette,
  },
  {
    title: "Round video clips",
    description: "Film short throw clips. Save them with your round history and replay them later.",
    icon: Video,
  },
  {
    title: "Watch Live",
    description: "Share scores, hole maps, marked shots, and saved clips. No spectator login.",
    icon: Radio,
  },
];

export function HomeScoringTeaser() {
  return h("section", {
    id: "scoring-app-teaser",
    "aria-labelledby": "scoring-teaser-title",
    "data-react-home-scoring-teaser": "ready",
  }, [
    h("div", { className: "scoring-teaser-copy", key: "copy" }, [
      h("p", { className: "scoring-teaser-kicker", key: "kicker" }, "The GVDG scoring app"),
      h("h2", { id: "scoring-teaser-title", key: "title" }, "Your round. Your way."),
      h("p", { className: "scoring-teaser-description", key: "description" }, "Keep score, make it your own, and bring your people along. All in your browser."),
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
