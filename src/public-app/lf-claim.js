// "Is this yours?", the return itself (contact, Returned, I got it back, karma) and the celebration form.
// A person always decides: the AI only suggested the match.
import React from "react";
import { PartyPopper } from "lucide-react";

import {
  CLAIM_STATUS_LABELS, celebrateHref, discTitle, LF_LIMITS, LF_MAX_PHOTOS, lfErrorMessage, postHref, withArticle,
} from "../shared/lost-found-model.js";
import { Note, StatusLine, useAction } from "./market-ui.js";
import { Facts, Gallery } from "./lf-post.js";
import { Field, PhotoPicker } from "./lf-form.js";
import { announceLfChange, LfLoad, lfRequest, PersonLine, PrivacyNote, SignInPrompt, useLfConfig, useLfResource } from "./lf-ui.js";

const h = React.createElement;

function needsIdentity(state, config) {
  return state.status === "error" && state.code === 401 && config.viewer.kind === "public";
}

export function MatchView({ id }) {
  const config = useLfConfig();
  const state = useLfResource("/lost-found/matches/" + id);
  const [message, setMessage] = React.useState("");
  const action = useAction();
  if (needsIdentity(state, config)) return h(SignInPrompt, { text: "Sign in or verify your email to see this possible match.", viewer: config.viewer });
  if (state.status !== "ready") return h("section", { "data-lf-state": state.status, "data-lf-view": "match" }, h(LfLoad, { missing: "This match is no longer open.", onRetry: state.retry, state }));
  const match = state.data.match;
  const post = match.found;
  const title = discTitle(post);

  async function decide(mine) {
    await action.run(async () => {
      const { ok, data } = await lfRequest(`/lost-found/matches/${id}/${mine ? "mine" : "not-mine"}`, { body: mine ? { message: message.trim() } : {}, method: "POST" });
      if (!ok) {
        action.setMessage({ text: lfErrorMessage(data), tone: "error" });
        return;
      }
      announceLfChange();
      if (mine && data.claim?.id) window.location.hash = "claim/" + data.claim.id;
      else action.setMessage({ text: "Thanks. We won't suggest this one again.", tone: "success" });
    });
  }

  return h("section", { "data-lf-state": "ready", "data-lf-view": "match" }, [
    h("a", { className: "market-back", href: "#mine", key: "back" }, "Back to my posts"),
    h("div", { className: "market-panel lf-match", "data-lf-match": match.id, "data-lf-strength": match.strength, key: "panel" }, [
      h("span", { className: "market-kicker", key: "kicker" }, match.strength === "strong" ? "STRONG MATCH" : "POSSIBLE MATCH"),
      h("h2", { className: "market-title", key: "title" }, "Is this yours?"),
      h("p", { className: "market-note", "data-lf-match-bag": match.bagDisc ? "true" : undefined, key: "lead" }, match.lost
        ? `Someone found ${withArticle(title)} that looks like your lost ${match.lost.title}.`
        : match.bagDisc
          ? `Someone found ${withArticle(title)} that looks like the ${match.bagDisc} in your bag.`
          : `Someone found ${withArticle(title)}, and it may be yours.`),
      h("div", { className: "market-detail", key: "detail" }, [
        h(Gallery, { key: "gallery", photos: post.photos, title }),
        h("div", { className: "lf-match-copy", key: "copy" }, [
          h(Facts, { key: "facts", post }),
          match.reasons?.length ? h("div", { className: "lf-reasons", key: "reasons" }, [
            h("h3", { className: "market-subhead", key: "t" }, "Why we think so"),
            h("ul", { className: "lf-reason-list", key: "l" }, match.reasons.map((reason) => h("li", { key: reason }, reason))),
          ]) : null,
          h("p", { className: "market-deal-who", key: "finder" }, h(PersonLine, { person: post.poster, prefix: "Found by" })),
        ]),
      ]),
      match.claim ? h("a", { className: "shop-btn", href: "#claim/" + match.claim.id, key: "claim" }, "Open your claim")
        : match.canDecide ? h("div", { className: "lf-decide", key: "decide" }, [
          h("label", { className: "market-field", key: "msg" }, ["Anything the finder should know? (optional)", h("textarea", {
            key: "input", maxLength: LF_LIMITS.message, onChange: (event) => setMessage(event.target.value), placeholder: "Best time and place to meet", rows: 2, value: message,
          })]),
          h("div", { className: "market-actions", key: "actions" }, [
            h("button", { className: "shop-btn", disabled: action.busy, key: "mine", onClick: () => decide(true), type: "button" }, "That's mine"),
            h("button", { className: "shop-btn secondary", disabled: action.busy, key: "not", onClick: () => decide(false), type: "button" }, "Not mine"),
          ]),
        ]) : h(Note, { key: "closed" }, "This match is closed."),
      h(PrivacyNote, { key: "privacy" }, "The finder never sees what you wrote privately about your disc. A club member always confirms; the AI only suggests."),
      h(StatusLine, { key: "status", message: action.message }),
    ]),
  ]);
}

function Steps({ status }) {
  const steps = [["open", "Claimed"], ["returned", "Returned"], ["confirmed", "Back home"]];
  const reached = { open: 1, returned: 2, confirmed: 3 }[status] || 0;
  return h("ol", { className: "lf-steps", "aria-label": "Return progress" }, steps.map(([key, label], index) => h("li", {
    "aria-current": reached === index + 1 ? "step" : undefined, className: "lf-step" + (reached > index ? " done" : ""), key,
  }, label)));
}

function RelayThread({ claim, reload }) {
  const [text, setText] = React.useState("");
  const action = useAction();
  const messages = Array.isArray(claim.contact?.messages) ? claim.contact.messages : [];
  async function send(event) {
    event.preventDefault();
    if (!text.trim()) return;
    await action.run(async () => {
      const { ok, data } = await lfRequest(`/lost-found/claims/${claim.id}/messages`, { body: { body: text.trim() }, method: "POST" });
      if (ok) { setText(""); reload(); } else action.setMessage({ text: lfErrorMessage(data), tone: "error" });
    });
  }
  return h("div", { className: "lf-thread", "data-lf-thread": messages.length }, [
    h("h3", { className: "market-subhead", key: "t" }, "Messages"),
    h(Note, { key: "n" }, "Messages are passed on by email. Nobody's email address or phone number is shared."),
    messages.length ? h("ul", { className: "lf-messages", key: "list" }, messages.map((message) => h("li", { className: "lf-message" + (message.mine ? " is-mine" : ""), key: message.id }, message.body))) : null,
    claim.canMessage ? h("form", { className: "market-form", key: "form", noValidate: true, onSubmit: send }, [
      h("label", { className: "public-sr-only", htmlFor: "lfMessage", key: "l" }, "Message"),
      h("textarea", { id: "lfMessage", key: "input", maxLength: LF_LIMITS.message, onChange: (event) => setText(event.target.value), placeholder: "Suggest a time and place", rows: 2, value: text }),
      h("button", { className: "shop-btn secondary", disabled: action.busy || !text.trim(), key: "send", type: "submit" }, action.busy ? "Sending…" : "Send message"),
    ]) : null,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function ClaimView({ id }) {
  const config = useLfConfig();
  const state = useLfResource("/lost-found/claims/" + id);
  const action = useAction();
  if (needsIdentity(state, config)) return h(SignInPrompt, { text: "Sign in or verify your email to see this return.", viewer: config.viewer });
  if (state.status !== "ready") return h("section", { "data-lf-state": state.status, "data-lf-view": "claim" }, h(LfLoad, { missing: "This return isn't available.", onRetry: state.retry, state }));
  const claim = state.data.claim;
  const post = claim.found || {};
  const title = discTitle(post);
  const finder = claim.role === "finder";
  const other = finder ? claim.owner : claim.finder;

  async function act(path, done) {
    await action.run(async () => {
      const { ok, data } = await lfRequest(`/lost-found/claims/${claim.id}/${path}`, { body: {}, method: "POST" });
      if (ok) {
        action.setMessage({ text: done, tone: "success" });
        announceLfChange();
      } else action.setMessage({ text: lfErrorMessage(data), tone: "error" });
    });
  }
  // Only the member app's own Messages thread link is accepted.
  const dmHref = claim.contact?.kind === "dm" ? String(claim.contact.href || "") : "";
  const safeDm = /^gvdg-members\.html#messages\?thread=\d{1,12}$/.test(dmHref) ? dmHref : "";

  return h("section", { "data-lf-claim-status": claim.status, "data-lf-role": claim.role, "data-lf-state": "ready", "data-lf-view": "claim" }, [
    h("a", { className: "market-back", href: "#mine", key: "back" }, "Back to my posts"),
    h("div", { className: "market-panel lf-claim", key: "panel" }, [
      h("span", { className: "market-kicker", key: "kicker" }, finder ? "YOU FOUND IT" : "YOUR DISC"),
      h("h2", { className: "market-title", key: "title" }, "Returning the " + title),
      h(Steps, { key: "steps", status: claim.status }),
      h("p", { className: "market-pending lf-claim-status", key: "claim-status" }, CLAIM_STATUS_LABELS[claim.status] || claim.status),
      h("p", { className: "market-deal-who", key: "other" }, h(PersonLine, { person: other, prefix: finder ? "Owner:" : "Finder:" })),
      // With relayed contact the claim message opens the thread below; with Messages it is shown here.
      claim.message && claim.contact?.kind === "dm" ? h("blockquote", { className: "market-quote", key: "msg" }, claim.message) : null,
      post.id ? h("a", { className: "market-link", href: postHref(post.id), key: "post" }, "See the post") : null,
      claim.status === "confirmed" && claim.karma ? h("p", { className: "lf-karma-win", "data-lf-karma-awarded": claim.karma.awarded ? "true" : "false", key: "karma" }, [
        h(PartyPopper, { "aria-hidden": true, key: "i", size: 20 }),
        h("span", { key: "t" }, claim.karma.awarded
          ? (finder ? `Back home! You earned +${claim.karma.points} karma.` : `Back home! ${claim.finder?.name || "The finder"} earned +${claim.karma.points} karma.`)
          : "Back home."),
      ]) : null,
      claim.contact?.kind === "dm"
        ? (safeDm ? h("a", { className: "shop-btn secondary", href: safeDm, key: "dm" }, `Message ${other?.name || "them"} in Messages`) : null)
        : h(RelayThread, { claim, key: "thread", reload: state.retry }),
      h("div", { className: "market-actions", key: "actions" }, [
        claim.canReturn ? h("button", { className: "shop-btn", disabled: action.busy, key: "returned", onClick: () => act("returned", "Marked returned. The owner will confirm."), type: "button" }, "Returned") : null,
        claim.canConfirm ? h("button", { className: "shop-btn", disabled: action.busy, key: "confirm", onClick: () => act("confirm", "Confirmed. Welcome back, disc!"), type: "button" }, "I got it back") : null,
        claim.canDispute ? h("button", { className: "shop-btn secondary", disabled: action.busy, key: "not-yet", onClick: () => act("not-yet", "Okay, the finder knows it isn't back yet."), type: "button" }, "Not yet") : null,
        claim.canDecline ? h("button", { className: "shop-btn secondary", disabled: action.busy, key: "decline", onClick: () => act("decline", "Claim closed."), type: "button" }, "Not their disc") : null,
        claim.canCancel ? h("button", { className: "market-text-btn", disabled: action.busy, key: "cancel", onClick: () => act("cancel", "Claim withdrawn."), type: "button" }, "Withdraw my claim") : null,
        claim.canCelebrate ? h("a", { className: "shop-btn", href: celebrateHref(claim.id), key: "celebrate" }, "Post a celebration") : null,
      ]),
      claim.status === "open" && finder ? h(Note, { key: "hint" }, "Once you've handed it over, tap Returned. The owner confirms, and you earn karma.") : null,
      claim.status === "returned" && !finder ? h(Note, { key: "hint2" }, "Confirm once the disc is in your hands so the finder gets their karma.") : null,
      h(StatusLine, { key: "status", message: action.message }),
    ]),
  ]);
}

export function CelebrateForm({ id }) {
  const config = useLfConfig();
  const state = useLfResource("/lost-found/claims/" + id);
  const [caption, setCaption] = React.useState("");
  const [photos, setPhotos] = React.useState([]);
  const action = useAction();
  if (needsIdentity(state, config)) return h(SignInPrompt, { text: "Sign in or verify your email to post a celebration.", viewer: config.viewer });
  if (state.status !== "ready") return h("section", { "data-lf-view": "celebrate" }, h(LfLoad, { onRetry: state.retry, state }));
  const claim = state.data.claim;
  async function submit(event) {
    event.preventDefault();
    if (!photos.length) {
      action.setMessage({ text: "Add a photo of the happy return.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const { ok, data } = await lfRequest(`/lost-found/claims/${claim.id}/celebrations`, {
        body: { caption: caption.trim(), photos: photos.map((photo) => photo.dataUrl) }, method: "POST",
      });
      if (ok) {
        announceLfChange();
        window.location.hash = "returned";
      } else action.setMessage({ text: lfErrorMessage(data), tone: "error" });
    });
  }
  if (!claim.canCelebrate) {
    return h("section", { "data-lf-view": "celebrate" }, [
      h("a", { className: "market-back", href: "#claim/" + claim.id, key: "back" }, "Back to the return"),
      h(Note, { key: "n" }, claim.celebrated ? "You've already posted a celebration for this return." : "Celebrations open once the owner confirms the disc is back."),
    ]);
  }
  return h("section", { "data-lf-view": "celebrate" }, [
    h("a", { className: "market-back", href: "#claim/" + claim.id, key: "back" }, "Back to the return"),
    h("form", { "aria-label": "Post a celebration", className: "market-form market-panel", key: "form", noValidate: true, onSubmit: submit }, [
      h("h2", { className: "my-orders-title", key: "t" }, "Celebrate the return"),
      h(PrivacyNote, { key: "privacy" }, "Celebration photos are public on the Returned wall."),
      h(PhotoPicker, { cameraHint: "The disc back where it belongs.", key: "photos", legend: "Photos (1 or 2)", max: LF_MAX_PHOTOS.celebration, min: 1, onError: (text) => action.setMessage({ text, tone: "error" }), photos, setPhotos }),
      h(Field, { id: "lfCaption", key: "caption", label: "Caption" },
        h("textarea", { id: "lfCaption", key: "input", maxLength: LF_LIMITS.caption, onChange: (event) => setCaption(event.target.value), placeholder: "Back in the bag where it belongs!", rows: 2, value: caption })),
      h("button", { className: "shop-btn market-submit", disabled: action.busy, key: "submit", type: "submit" }, action.busy ? "Posting…" : "Post celebration"),
      h(StatusLine, { key: "status", message: action.message }),
    ]),
  ]);
}
