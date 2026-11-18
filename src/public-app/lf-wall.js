// The Returned wall (celebrations + recent returns + Top finders) and a finder's profile with their karma.
import React from "react";
import { Trophy } from "lucide-react";

import { karmaLabel, personHref, postHref, shortDay } from "../shared/lost-found-model.js";
import { Note } from "./market-ui.js";
import { PostCard } from "./lf-list.js";
import { KarmaBadge, LfLoad, LfPhoto, LfReportControl, PersonLine, useLfConfig, useLfResource } from "./lf-ui.js";

const h = React.createElement;

export function CelebrationCard({ celebration, viewer }) {
  const who = celebration.role === "owner" ? "got their disc back" : "returned a disc";
  return h("article", { className: "product-card market-card lf-celebration", "data-lf-celebration": celebration.id }, [
    h("div", { className: "market-card-photo", key: "photo" }, h(LfPhoto, { alt: celebration.caption || "Celebration photo",
      pending: !celebration.photos?.length && celebration.photoPending > 0, photo: celebration.photos?.[0] })),
    h("div", { className: "product-body", key: "body" }, [
      celebration.caption ? h("p", { className: "product-name lf-caption", key: "caption" }, celebration.caption) : null,
      h("div", { className: "product-meta", key: "who" }, h(PersonLine, { person: celebration.author })),
      h("div", { className: "product-meta", key: "what" }, [who, ": ", celebration.disc, celebration.course ? " · " + celebration.course.name : "",
        celebration.returnedAt ? " · " + shortDay(celebration.returnedAt) : ""].join("")),
      celebration.role === "owner" && celebration.finder ? h("div", { className: "product-meta", key: "finder" }, h(PersonLine, { person: celebration.finder, prefix: "Found by" })) : null,
      celebration.mine ? null : h(LfReportControl, { id: celebration.id, key: "report", kind: "celebration", viewer }),
    ]),
  ]);
}

export function TopFinders({ finders }) {
  if (!finders?.length) return null;
  return h("aside", { "aria-label": "Top finders", className: "market-panel lf-top", "data-lf-top-finders": finders.length }, [
    h("h2", { className: "my-orders-title", key: "t" }, [h(Trophy, { "aria-hidden": true, className: "lf-top-icon", key: "i", size: 18 }), " Top finders"]),
    h("ol", { className: "lf-top-list", key: "list" }, finders.map((finder, index) => h("li", { className: "lf-top-row", key: finder.key || index }, [
      h("span", { className: "lf-top-rank", key: "rank" }, String(index + 1)),
      finder.key ? h("a", { className: "market-trader-name", href: personHref(finder.key), key: "name" }, finder.name) : h("strong", { key: "name" }, finder.name),
      h("span", { className: "market-feedback lf-top-karma", key: "karma" }, karmaLabel(finder)),
    ]))),
  ]);
}

export function ReturnedWall() {
  const config = useLfConfig();
  const state = useLfResource("/lost-found/returned");
  if (state.status !== "ready") return h("section", { "data-lf-state": state.status, "data-lf-view": "returned" }, h(LfLoad, { loading: "Loading returned discs…", onRetry: state.retry, state }));
  const celebrations = Array.isArray(state.data.celebrations) ? state.data.celebrations : [];
  const celebrated = new Set(celebrations.map((row) => row.claimId));
  const quiet = (state.data.recent || []).filter((row) => !celebrated.has(row.claimId));
  const viewer = state.data.viewer || config.viewer;
  return h("section", { "data-lf-state": "ready", "data-lf-view": "returned" }, [
    h("div", { className: "lf-wall-layout", key: "layout" }, [
      h("div", { className: "lf-wall-main", key: "main" }, [
        h("div", { className: "shop-catalog-bar", key: "bar" }, h("h2", null, "Back home")),
        celebrations.length || quiet.length ? h("div", { className: "product-grid market-grid lf-grid", "data-lf-wall": celebrations.length, key: "grid" }, [
          ...celebrations.map((row) => h(CelebrationCard, { celebration: row, key: "c" + row.id, viewer })),
          ...quiet.map((row) => h("article", { className: "product-card market-card lf-celebration", "data-lf-return": row.claimId, key: "r" + row.claimId }, [
            h("a", { "aria-hidden": "true", className: "market-card-photo", href: postHref(row.postId), key: "photo", tabIndex: -1 }, h(LfPhoto, { alt: "", photo: row.photo })),
            h("div", { className: "product-body", key: "body" }, [
              h("a", { className: "product-name market-card-title", href: postHref(row.postId), key: "t" }, row.disc),
              h("div", { className: "product-meta", key: "who" }, h(PersonLine, { person: row.finder, prefix: "Returned by" })),
              h("div", { className: "product-meta", key: "when" }, [row.course?.name, shortDay(row.returnedAt)].filter(Boolean).join(" · ")),
            ]),
          ])),
        ]) : h("p", { className: "public-state", key: "none", role: "status" }, "No returns yet. The first finder to bring a disc home tops the list."),
      ]),
      h(TopFinders, { finders: state.data.topFinders, key: "top" }),
    ]),
  ]);
}

export function PersonProfile({ personKey }) {
  const config = useLfConfig();
  const state = useLfResource("/lost-found/people/" + personKey);
  if (state.status !== "ready") return h("section", { "data-lf-view": "person" }, h(LfLoad, { missing: "We couldn't find that person.", onRetry: state.retry, state }));
  const { person, celebrations = [], posts = [] } = state.data;
  const viewer = state.data.viewer || config.viewer;
  return h("section", { "data-lf-state": "ready", "data-lf-view": "person" }, [
    h("a", { className: "market-back", href: "#returned", key: "back" }, "Back to returned discs"),
    h("div", { className: "market-panel market-trader-head", key: "head" }, [
      h("h2", { className: "market-title", key: "name" }, [person.name, " ", h(KarmaBadge, { key: "k", person })]),
      h(Note, { key: "n" }, karmaLabel(person) ? "Karma comes from discs returned to their owners: +10 for each confirmed return." : "No returns yet."),
    ]),
    celebrations.length ? h("div", { className: "product-grid market-grid lf-grid", key: "celebrations" },
      celebrations.map((row) => h(CelebrationCard, { celebration: row, key: row.id, viewer }))) : null,
    posts.length ? h("div", { className: "shop-catalog-bar", key: "posts-bar" }, h("h2", null, "Found discs waiting for their owners")) : null,
    posts.length ? h("div", { className: "product-grid market-grid lf-grid", key: "posts" }, posts.map((post) => h(PostCard, { key: post.id, post, showPoster: false }))) : null,
  ]);
}
