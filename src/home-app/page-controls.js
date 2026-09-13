import React from "react";
import { ArrowUp } from "lucide-react";

import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";

const h = React.createElement;

function icon(Icon, props = {}) {
  return h(Icon, {
    ...props,
    "aria-hidden": "true",
    focusable: "false",
    size: props.size || 20,
    strokeWidth: props.strokeWidth || 2.4,
  });
}

export function HomeThemeToggle() {
  return h(PlayerThemeToggle);
}

export function HomeBackToTop() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    let ticking = false;
    function update() {
      setVisible(window.scrollY > 600);
      ticking = false;
    }
    function handleScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    update();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return h(
    "button",
    {
      className: "back-to-top" + (visible ? " visible" : ""),
      type: "button",
      "aria-label": "Back to top",
      onClick: () => window.scrollTo({ top: 0, behavior: "smooth" }),
    },
    icon(ArrowUp, { size: 22 }),
  );
}
