import React from "react";
import { Disc3, MoveLeft } from "lucide-react";

const h = React.createElement;

function icon(Icon, size = 18) {
  return h(Icon, {
    "aria-hidden": "true",
    focusable: "false",
    size,
    strokeWidth: 2.5,
  });
}

export function BlogApp() {
  return h(React.Fragment, null, [
    h("section", { className: "page-hero", "data-react-blog": "hero", key: "hero" },
      h("div", { className: "page-hero-content" }, [
        h("h1", { className: "page-title", key: "title" }, "Club Blog"),
        h("p", { className: "page-subtitle", key: "subtitle" },
          "News, tips, tournament recaps, and stories from the Greenville disc golf community"),
      ])),
    h("section", { className: "construction-section", "data-react-blog": "coming-soon", key: "content" },
      h("div", { className: "construction-card" }, [
        h("div", { className: "disc-icon", key: "icon" }, icon(Disc3, 32)),
        h("h2", { className: "construction-heading", key: "heading" }, [
          "Blog ",
          h("span", { key: "soon" }, "Coming Soon"),
        ]),
        h("p", { className: "construction-text", key: "text" },
          "Club stories are coming here. In the meantime, browse upcoming rounds and recent results on the events page."),
        h("div", { className: "blog-actions", key: "actions" }, [
          h("a", { className: "back-btn", href: "events.html", key: "events" }, "Browse events"),
          h("a", { className: "blog-home-link", href: "index.html", key: "back" }, [
            h(MoveLeft, { "aria-hidden": "true", key: "icon", size: 18, strokeWidth: 2.5 }),
            h("span", { key: "text" }, "Back to home"),
          ]),
        ]),
      ])),
  ]);
}
