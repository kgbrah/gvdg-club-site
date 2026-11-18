// My posts: "Is this yours?" suggestions, returns in progress (either side), my posts and my karma.
import React from "react";
import { Handshake, PackageSearch } from "lucide-react";

import {
  CLAIM_STATUS_LABELS, celebrateHref, claimHref, discTitle, karmaLabel, matchHref, postHref, postMeta, POST_STATUS_LABELS,
} from "../shared/lost-found-model.js";
import { Note } from "./market-ui.js";
import { LfLoad, LfPhoto, SignInPrompt, useLfConfig, useLfResource } from "./lf-ui.js";
import { PhotoNudges } from "./lf-nudge.js";

const h = React.createElement;

function Row({ href, photo, title, detail, status, data }) {
  return h("li", { className: "market-my-listing lf-row", ...data }, [
    h(LfPhoto, { alt: "", className: "market-my-thumb", key: "photo", photo }),
    h("div", { className: "market-my-copy", key: "copy" }, [
      h("a", { className: "market-card-title", href, key: "title" }, title),
      detail ? h("span", { className: "product-meta", key: "detail" }, detail) : null,
      status ? h("span", { className: "market-note lf-row-status", key: "status" }, status) : null,
    ]),
  ]);
}

function Section({ title, label, children, data }) {
  return h("section", { "aria-label": label || title, className: "market-panel", ...data }, [
    h("h2", { className: "my-orders-title", key: "title" }, title),
    ...[].concat(children),
  ]);
}

export function MyLostFound() {
  const config = useLfConfig();
  const state = useLfResource("/lost-found/me");
  if (state.status === "error" && state.code === 401) {
    return h("section", { "data-lf-view": "mine", "data-lf-state": "signin" }, h(SignInPrompt, { text: "Sign in or verify your email to see your posts and returns.", viewer: config.viewer }));
  }
  if (state.status !== "ready") return h("section", { "data-lf-state": state.status, "data-lf-view": "mine" }, h(LfLoad, { onRetry: state.retry, state }));
  const data = state.data;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const claims = Array.isArray(data.claims) ? data.claims : [];
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const active = claims.filter((claim) => claim.status === "open" || claim.status === "returned");
  const done = claims.filter((claim) => claim.status === "confirmed");
  const karma = karmaLabel(data.karma);
  const nudges = (Array.isArray(data.nudges) ? data.nudges : []).map((photo) => ({
    ...photo, label: photo.celebrationId ? "Your celebration of the " + photo.title : photo.title, href: photo.postId ? postHref(photo.postId) : "#returned",
  }));
  return h("section", { "data-lf-state": "ready", "data-lf-view": "mine" }, [
    h("p", { className: "market-identity", "data-lf-my-karma": data.karma?.karma || 0, key: "karma" }, karma
      ? ["Your karma: ", h("strong", { key: "k" }, karma)]
      : "Earn karma: +1 for every round you finish in the scoring app, +10 for every disc you return to its owner."),
    h(PhotoNudges, { heading: nudges.length > 1 ? "Check your photos" : "Check your photo", key: "nudges", onChanged: state.retry, photos: nudges }),
    matches.length ? h(Section, { data: { "data-lf-section": "matches" }, key: "matches", title: "Is this yours?" },
      h("ul", { className: "market-my-listings", key: "list" }, matches.map((match) => h(Row, {
        data: { "data-lf-match-row": match.id }, detail: postMeta(match.found), href: matchHref(match.id), key: match.id,
        photo: match.found.photos?.[0],
        status: match.strength === "strong" ? "Strong match — take a look" : "Possible match", title: discTitle(match.found),
      })))) : null,
    h(Section, { data: { "data-lf-section": "returns" }, key: "returns", title: "Returns in progress" }, active.length
      ? h("ul", { className: "market-my-listings", key: "list" }, active.map((claim) => h(Row, {
        data: { "data-lf-claim-row": claim.id, "data-lf-claim-status": claim.status }, detail: claim.role === "finder" ? `You found it · ${claim.owner?.name || "Owner"}` : `Found by ${claim.finder?.name || "a finder"}`,
        href: claimHref(claim.id), key: claim.id, photo: claim.found?.photos?.[0], status: CLAIM_STATUS_LABELS[claim.status], title: discTitle(claim.found || {}),
      })))
      : h(Note, { key: "none" }, "Nothing in progress.")),
    done.length ? h(Section, { data: { "data-lf-section": "returned" }, key: "done", title: "Back home" },
      h("ul", { className: "market-my-listings", key: "list" }, done.map((claim) => h(Row, {
        detail: claim.role === "finder" ? (claim.karma?.awarded ? `You earned +${claim.karma.points} karma` : "Returned") : `Returned by ${claim.finder?.name || "a finder"}`,
        href: claim.canCelebrate ? celebrateHref(claim.id) : claimHref(claim.id), key: claim.id, photo: claim.found?.photos?.[0],
        status: claim.canCelebrate ? "Post a celebration" : "Returned", title: discTitle(claim.found || {}),
      })))) : null,
    h(Section, { data: { "data-lf-section": "posts" }, key: "posts", title: "Your posts" }, posts.length
      ? h("ul", { className: "market-my-listings", key: "list" }, posts.map((post) => h(Row, {
        data: { "data-lf-my-post": post.id }, detail: (post.kind === "lost" ? "Lost · " : "Found · ") + postMeta(post), href: postHref(post.id), key: post.id,
        photo: post.photos?.[0], status: POST_STATUS_LABELS[post.status] || post.status, title: discTitle(post),
      })))
      : h("div", { className: "market-actions", key: "none" }, [
        h("a", { className: "shop-btn", href: "#new/found", key: "found" }, [h(Handshake, { "aria-hidden": true, key: "i", size: 18 }), " Post a found disc"]),
        h("a", { className: "shop-btn secondary", href: "#new/lost", key: "lost" }, [h(PackageSearch, { "aria-hidden": true, key: "i", size: 18 }), " Post a lost disc"]),
      ])),
  ]);
}
