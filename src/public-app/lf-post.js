// One Lost & Found post: the redacted photos and details, the poster's karma, and what this viewer can do
// (claim it, follow a match, or - for the poster - see claims, turn it in to a club bin, or close it).
import React from "react";

import {
  aiFieldsNote, CLAIM_STATUS_LABELS, claimHref, discTitle, holdingText, lfErrorMessage, matchHref, POST_STATUS_LABELS, shortDay,
} from "../shared/lost-found-model.js";
import { Note, StatusLine, useAction } from "./market-ui.js";
import {
  announceLfChange, LfLoad, LfPhoto, lfRequest, LfReportControl, PersonLine, PrivacyNote, useLfConfig, useLfIdentityGate, useLfResource,
} from "./lf-ui.js";

const h = React.createElement;

export function Gallery({ photos, pending, title }) {
  const list = Array.isArray(photos) && photos.length ? photos : [null];
  const [index, setIndex] = React.useState(0);
  const current = list[Math.min(index, list.length - 1)];
  return h("div", { className: "market-gallery", "data-lf-gallery": photos?.length || 0 }, [
    h(LfPhoto, { alt: title + (list.length > 1 ? `, photo ${index + 1} of ${list.length}` : ""), className: "product-img market-gallery-main", key: "main",
      pending: !photos?.length && pending > 0, photo: current }),
    list.length > 1 ? h("div", { className: "market-thumbs", key: "thumbs" }, list.map((photo, position) => h("button", {
      "aria-label": `Show photo ${position + 1}`, "aria-pressed": position === index ? "true" : "false", className: "market-thumb", key: photo?.id || position,
      onClick: () => setIndex(position), type: "button",
    }, h(LfPhoto, { alt: "", className: "market-thumb-img", photo })))) : null,
    photos?.length ? h("p", { className: "market-hint", key: "redacted" }, "Any writing on the disc is blurred in this photo.")
      : pending ? h("p", { className: "market-hint", key: "pending" }, "We're still checking the photo. It appears once any writing on the disc is blurred out.") : null,
  ]);
}

export function Facts({ post }) {
  const found = post.kind === "found";
  const rows = [
    ["Brand", post.brand], ["Mold", post.mold], ["Plastic", post.plastic], ["Colour", post.color],
    ["Course", post.course?.name], ["Hole or area", post.area], [found ? "Found" : "Lost", shortDay(post.date)],
    ["Where it is now", found ? holdingText(post) : ""], ["Reward", post.rewardNote],
  ].filter(([, value]) => value);
  return h("dl", { className: "market-facts" }, rows.map(([label, value]) => h("div", { className: "market-fact", key: label }, [
    h("dt", { key: "dt" }, label), h("dd", { key: "dd" }, value),
  ])));
}

function ClaimForm({ post, viewer, match }) {
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const action = useAction();
  const identity = useLfIdentityGate(viewer);
  async function send() {
    await action.run(async () => {
      const path = match ? `/lost-found/matches/${match.id}/mine` : `/lost-found/posts/${post.id}/claim`;
      const { ok, data } = await lfRequest(path, { body: { message: message.trim() }, method: "POST" });
      if (ok && data.claim?.id) {
        announceLfChange();
        window.location.hash = claimHref(data.claim.id).slice(1);
      } else action.setMessage({ text: lfErrorMessage(data), tone: "error" });
    });
  }
  if (!open) return h("button", { className: "shop-btn market-buy", "data-lf-claim-open": "true", onClick: () => setOpen(true), type: "button" }, "This is mine");
  return h("div", { className: "market-trade-form lf-claim-form" }, [
    h("form", { className: "market-form", key: "form", noValidate: true,
      onSubmit: (event) => { event.preventDefault(); identity.require("Verify your email to claim this disc", send); } }, [
      h("label", { key: "message" }, ["How will the finder know it's yours?", h("textarea", {
        key: "input", maxLength: 500, onChange: (event) => setMessage(event.target.value), placeholder: "What's written on it, a mark or dent, where you lost it…", rows: 3, value: message,
      })]),
      h(Note, { key: "note" }, "Only the finder sees this. They'll arrange the return with you; nobody's email or phone is shared."),
      h("div", { className: "market-actions", key: "actions" }, [
        h("button", { className: "shop-btn", disabled: action.busy, key: "send", type: "submit" }, action.busy ? "Sending…" : "Send claim"),
        h("button", { className: "shop-filter-reset", key: "cancel", onClick: () => setOpen(false), type: "button" }, "Cancel"),
      ]),
    ]),
    identity.gate,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

function PosterTools({ post, reload }) {
  const action = useAction();
  const [bin, setBin] = React.useState("");
  const [binOpen, setBinOpen] = React.useState(false);
  const [confirmClose, setConfirmClose] = React.useState(false);
  async function act(path, body, done) {
    await action.run(async () => {
      const { ok, data } = await lfRequest(`/lost-found/posts/${post.id}/${path}`, { body, method: "POST" });
      if (ok) {
        action.setMessage({ text: done, tone: "success" });
        announceLfChange();
        reload();
      } else action.setMessage({ text: lfErrorMessage(data), tone: "error" });
    });
  }
  const claims = Array.isArray(post.claims) ? post.claims : [];
  const matches = Array.isArray(post.matches) ? post.matches : [];
  return h("section", { className: "market-panel market-seller-tools", "data-lf-poster-tools": "true" }, [
    h("h3", { className: "market-subhead", key: "title" }, "Your post"),
    post.kind === "found" ? h(Note, { key: "notified" }, post.ownersNotified
      ? `We let ${post.ownersNotified === 1 ? "a possible owner" : post.ownersNotified + " possible owners"} know.`
      : "We'll let you know if someone may own it.") : null,
    claims.length ? h("ul", { className: "market-offers", key: "claims" }, claims.map((claim) => h("li", { className: "market-offer", "data-lf-claim": claim.id, key: claim.id }, [
      h("p", { className: "market-deal-who", key: "who" }, [h(PersonLine, { key: "p", person: claim.owner, prefix: "Claimed by" })]),
      claim.message ? h("blockquote", { className: "market-quote", key: "msg" }, claim.message) : null,
      h("p", { className: "market-note", key: "status" }, CLAIM_STATUS_LABELS[claim.status] || claim.status),
      h("a", { className: "shop-btn secondary", href: claimHref(claim.id), key: "open" }, "Open the return"),
    ]))) : null,
    post.privateInk != null ? h("div", { className: "lf-private", key: "ink" }, [
      h("p", { className: "market-kicker", key: "k" }, "ONLY YOU SEE THIS"),
      h("p", { className: "market-note", key: "v" }, post.privateInk ? "What's written on it: " + post.privateInk : "You didn't add what's written on it."),
    ]) : null,
    matches.length ? h("ul", { className: "market-offers", key: "matches" }, matches.map((match) => h("li", { className: "market-offer", "data-lf-match": match.id, key: match.id }, [
      h("p", { className: "market-deal-who", key: "who" }, match.strength === "strong" ? "Strong match: a found disc looks like yours" : "Possible match: a found disc may be yours"),
      h("a", { className: "shop-btn", href: matchHref(match.id), key: "open" }, "Is this yours?"),
    ]))) : null,
    post.canTurnIn ? (binOpen
      ? h("form", { className: "market-form", key: "bin", noValidate: true, onSubmit: (event) => { event.preventDefault(); void act("turn-in", { binNote: bin.trim() }, "Marked as turned in."); } }, [
        h("label", { key: "label" }, ["Which club bin?", h("input", { key: "input", maxLength: 80, onChange: (event) => setBin(event.target.value), placeholder: "Elm Street Park shed", type: "text", value: bin })]),
        h("div", { className: "market-actions", key: "actions" }, [
          h("button", { className: "shop-btn", disabled: action.busy || !bin.trim(), key: "save", type: "submit" }, "Save"),
          h("button", { className: "shop-filter-reset", key: "cancel", onClick: () => setBinOpen(false), type: "button" }, "Cancel"),
        ]),
      ])
      : h("button", { className: "shop-btn secondary", key: "bin-open", onClick: () => setBinOpen(true), type: "button" }, "I turned it in to a club bin")) : null,
    post.canClose ? (confirmClose
      ? h("div", { className: "market-actions", key: "close" }, [
        h("button", { className: "shop-btn", disabled: action.busy, key: "yes", onClick: () => act("close", {}, "Post closed."), type: "button" }, "Yes, close it"),
        h("button", { className: "shop-filter-reset", key: "no", onClick: () => setConfirmClose(false), type: "button" }, "Keep it open"),
      ])
      : h("button", { className: "market-text-btn", key: "close-open", onClick: () => setConfirmClose(true), type: "button" }, "Close this post")) : null,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function PostDetail({ id }) {
  const config = useLfConfig();
  const state = useLfResource("/lost-found/posts/" + id);
  if (state.status !== "ready") {
    return h("section", { "data-lf-state": state.status, "data-lf-view": "post" }, [
      h("a", { className: "market-back", href: "#found", key: "back" }, "Back to found discs"),
      h(LfLoad, { key: "load", missing: "This post is no longer up.", onRetry: state.retry, state }),
    ]);
  }
  const post = state.data.post;
  const viewer = state.data.viewer || config.viewer;
  const title = discTitle(post);
  const found = post.kind === "found";
  const ai = aiFieldsNote(post.aiFields);
  const reload = state.retry;
  return h("section", { "data-lf-kind": post.kind, "data-lf-state": "ready", "data-lf-view": "post" }, [
    h("a", { className: "market-back", href: found ? "#found" : "#lost", key: "back" }, found ? "Back to found discs" : "Back to lost discs"),
    h("div", { className: "market-detail", key: "detail" }, [
      h(Gallery, { key: "gallery", pending: post.photoPending, photos: post.photos, title }),
      h("div", { className: "market-panel lf-detail-panel", key: "panel" }, [
        h("span", { className: "market-kicker", key: "kind" }, found ? "FOUND DISC" : "LOST DISC"),
        h("h2", { className: "market-title", key: "title" }, title),
        post.status !== "open" ? h("p", { className: "market-price", key: "status" }, h("span", { className: "market-chip market-chip-pending" }, POST_STATUS_LABELS[post.status] || post.status)) : null,
        ai ? h("p", { className: "market-hint", key: "ai" }, ai) : null,
        h(Facts, { key: "facts", post }),
        h("p", { className: "market-deal-who", key: "poster" }, h(PersonLine, { person: post.poster, prefix: found ? "Found by" : "Posted by" })),
        post.mine ? null : post.myClaim ? h("a", { className: "shop-btn market-buy", href: claimHref(post.myClaim.id), key: "my-claim" }, "Your claim: " + (CLAIM_STATUS_LABELS[post.myClaim.status] || "open"))
          : post.myMatch ? h("a", { className: "shop-btn market-buy", href: matchHref(post.myMatch.id), key: "my-match" }, "We think this may be yours")
            : found && post.canClaim ? h(ClaimForm, { key: "claim", post, viewer })
              : !found ? h("a", { className: "shop-btn secondary", href: "#new/found", key: "found-it" }, "Found it? Post a found disc") : null,
        found && !post.mine ? h(PrivacyNote, { key: "privacy" }, "Writing on found discs is read privately to find the owner and is never shown here.") : null,
        post.canReport ? h(LfReportControl, { id: post.id, key: "report", kind: "post", label: "Report this post", viewer }) : null,
      ]),
    ]),
    post.mine ? h(PosterTools, { key: "tools", post, reload }) : null,
  ]);
}
