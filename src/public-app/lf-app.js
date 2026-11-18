// Lost & Found (lost-found.html): Found discs / Lost discs / Returned / My posts. A lazy chunk of the public
// bundle, loaded only on this page. Same page shell, cards and palette as the Pro Shop.
import React from "react";

import { LF_TAB_COPY, LF_TABS, parseLfRoute } from "../shared/lost-found-model.js";
import { clearGuest } from "./market-api.js";
import { GuestBadge } from "./market-ui.js";
import { ClaimView, CelebrateForm, MatchView } from "./lf-claim.js";
import { NewPost } from "./lf-form.js";
import { PostList } from "./lf-list.js";
import { MyLostFound } from "./lf-mine.js";
import { PostDetail } from "./lf-post.js";
import { useLfConfig } from "./lf-ui.js";
import { PersonProfile, ReturnedWall } from "./lf-wall.js";

const h = React.createElement;

function useLocationHash() {
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
}

function IdentityPanel() {
  const { viewer } = useLfConfig();
  if (viewer.kind === "member" || viewer.kind === "guest") {
    const guest = viewer.kind === "guest";
    return h("aside", { className: "wallet-panel market-identity-panel", "data-lf-identity": viewer.kind }, [
      h("div", { className: "wallet-label", key: "label" }, guest ? "Posting as a guest" : "Signed in"),
      h("div", { className: "wallet-balance", key: "value" }, viewer.name || (guest ? "Guest" : "Member")),
      h("p", { className: "wallet-note", key: "note" }, guest
        ? [h(GuestBadge, { key: "badge" }), " · ", h("button", { className: "market-text-btn", key: "out", onClick: clearGuest, type: "button" }, "Not you?")]
        : [h("a", { href: "#new/found", key: "found" }, "Post a found disc"), " · ", h("a", { href: "#new/lost", key: "lost" }, "Post a lost disc")]),
    ]);
  }
  return h("aside", { className: "wallet-panel market-identity-panel", "data-lf-identity": "public" }, [
    h("div", { className: "wallet-label", key: "label" }, "Lost & Found"),
    h("div", { className: "wallet-balance", key: "value" }, "Anyone can post"),
    h("p", { className: "wallet-note", key: "note" }, [
      h("a", { href: "gvdg-members.html", key: "sign-in" }, "Members sign in"),
      ". Not a member? Post or claim a disc after a quick email check.",
    ]),
  ]);
}

function Tabs({ tab }) {
  return h("nav", { "aria-label": "Lost & Found sections", className: "shop-sections lf-tabs" }, LF_TABS.map(([key, href, label]) => h("a", {
    "aria-current": key === tab ? "page" : undefined, className: "shop-section-link" + (key === tab ? " on" : ""), href, key,
  }, label)));
}

export function LostFoundApp() {
  const hash = useLocationHash();
  const route = parseLfRoute(hash);
  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [hash]);
  let body;
  if (route.view === "new") body = h(NewPost, { key: "new-" + route.kind, kind: route.kind });
  else if (route.view === "post") body = h(PostDetail, { id: route.id, key: "post-" + route.id });
  else if (route.view === "match") body = h(MatchView, { id: route.id, key: "match-" + route.id });
  else if (route.view === "claim") body = h(ClaimView, { id: route.id, key: "claim-" + route.id });
  else if (route.view === "celebrate") body = h(CelebrateForm, { id: route.id, key: "celebrate-" + route.id });
  else if (route.view === "person") body = h(PersonProfile, { key: "person-" + route.key, personKey: route.key });
  else if (route.view === "wall") body = h(ReturnedWall, { key: "wall" });
  else if (route.view === "mine") body = h(MyLostFound, { key: "mine" });
  else body = h(PostList, { key: "list-" + route.tab, kind: route.tab, route });
  return h("main", { "data-lf-tab": route.tab, "data-react-lost-found": "ready" }, [
    h("div", { className: "shop-head", key: "head" }, [
      h("div", { key: "copy" }, [
        h("h1", { className: "page-title", key: "title" }, "Lost & Found"),
        h("p", { className: "page-subtitle", key: "subtitle" }, LF_TAB_COPY[route.tab]),
      ]),
      h(IdentityPanel, { key: "identity" }),
    ]),
    h(Tabs, { key: "tabs", tab: route.tab }),
    h("div", { className: "market-root lf-root", key: "root" }, body),
  ]);
}
