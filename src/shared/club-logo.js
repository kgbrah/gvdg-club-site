import React from "react";

const h = React.createElement;

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
      src: "img/logo.png",
      width: 50,
    }),
    h("span", { className: "logo-wordmark", key: "word" }, [
      "Greenville ",
      h("em", { key: "dgc" }, "DGC"),
    ]),
  ]);
}
