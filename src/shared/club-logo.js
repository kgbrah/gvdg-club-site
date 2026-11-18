import React from "react";

const h = React.createElement;

// Headers show only the logo's mark: img/logo.png drawn into a 29-44 px square with object-fit: cover from the
// left, so its wordmark is never visible. These files are that image with the wordmark area left transparent,
// which keeps the drawn pixels the same as logo.png:
// - logo-mark-234.png keeps logo.png's pixel grid (identical at any density; used on 3x screens);
// - logo-mark-117.png is its first half-size level, which is what the browser already samples from logo.png
//   when it draws it at 1x and 2x.
export const CLUB_LOGO_MARK = "img/logo-mark-117.png";
export const CLUB_LOGO_MARK_SRCSET = "img/logo-mark-117.png 1x, img/logo-mark-117.png 2x, img/logo-mark-234.png 3x";

export function ClubLogo({ href = "index.html", onClick } = {}) {
  return h("a", {
    "aria-label": "Greenville DGC home",
    className: "logo",
    href,
    onClick,
  }, [
    h("img", {
      alt: "",
      className: "logo-image",
      height: 50,
      key: "mark",
      src: CLUB_LOGO_MARK,
      srcSet: CLUB_LOGO_MARK_SRCSET,
      width: 50,
    }),
    h("span", { className: "logo-wordmark", key: "word" }, [
      "Greenville ",
      h("em", { key: "dgc" }, "DGC"),
    ]),
  ]);
}
