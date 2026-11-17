import React from "react";

import { FEEDBACK_RATINGS, LIMITS, shortDate } from "../shared/market-model.js";
import { errorMessage, marketRequest } from "./market-api.js";
import { ReportControl, StatusLine, TraderLine, useAction } from "./market-ui.js";
import { announceMarketChange } from "./market-listing.js";

const h = React.createElement;
const RATING_LABELS = Object.fromEntries(FEEDBACK_RATINGS);

export function FeedbackForm({ dealId, existing = null, onDone, onCancel }) {
  const [rating, setRating] = React.useState(existing?.rating || "");
  const [comment, setComment] = React.useState(existing?.comment || "");
  const action = useAction();
  const name = React.useId();

  async function submit(event) {
    event.preventDefault();
    if (!rating) {
      action.setMessage({ text: "Choose positive, neutral or negative.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const body = { comment: comment.trim(), rating };
      const { ok, data } = existing
        ? await marketRequest("/market/feedback/" + existing.id, { body, method: "PATCH" })
        : await marketRequest("/market/feedback", { body: { ...body, dealId }, method: "POST" });
      if (ok) {
        action.setMessage({ text: existing ? "Feedback updated." : "Thanks for the feedback.", tone: "success" });
        announceMarketChange();
        onDone?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }

  return h("form", { "aria-label": existing ? "Edit feedback" : "Leave feedback", className: "market-form market-feedback-form", noValidate: true, onSubmit: submit }, [
    h("fieldset", { className: "market-fieldset market-rating", key: "rating" }, [
      h("legend", { key: "legend" }, "How did it go?"),
      ...FEEDBACK_RATINGS.map(([value, label]) => h("label", { className: "market-check", key: value }, [
        h("input", { checked: rating === value, key: "input", name, onChange: () => setRating(value), type: "radio", value }),
        label,
      ])),
    ]),
    h("label", { key: "comment" }, ["Comment", h("textarea", {
      key: "input", maxLength: LIMITS.comment, onChange: (event) => setComment(event.target.value), rows: 2, value: comment,
    })]),
    h("div", { className: "market-actions", key: "actions" }, [
      h("button", { className: "shop-btn", disabled: action.busy, key: "submit", type: "submit" }, action.busy ? "Saving…" : existing ? "Save feedback" : "Leave feedback"),
      onCancel ? h("button", { className: "shop-filter-reset", key: "cancel", onClick: onCancel, type: "button" }, "Cancel") : null,
    ]),
    existing ? h("small", { className: "market-hint", key: "once" }, "Feedback can be edited once, within 7 days.") : null,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

function ReplyForm({ feedback, onDone, onCancel }) {
  const [body, setBody] = React.useState("");
  const action = useAction();
  async function submit(event) {
    event.preventDefault();
    if (!body.trim()) {
      action.setMessage({ text: "Write a short reply.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/feedback/${feedback.id}/reply`, { body: { body: body.trim() }, method: "POST" });
      if (ok) {
        announceMarketChange();
        onDone?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  return h("form", { "aria-label": "Reply to feedback", className: "market-form", noValidate: true, onSubmit: submit }, [
    h("label", { key: "body" }, ["Your reply", h("textarea", { key: "input", maxLength: LIMITS.reply, onChange: (event) => setBody(event.target.value), rows: 2, value: body })]),
    h("div", { className: "market-actions", key: "actions" }, [
      h("button", { className: "shop-btn secondary", disabled: action.busy, key: "submit", type: "submit" }, action.busy ? "Posting…" : "Post reply"),
      h("button", { className: "shop-filter-reset", key: "cancel", onClick: onCancel, type: "button" }, "Cancel"),
    ]),
    h("small", { className: "market-hint", key: "once" }, "You can post one reply."),
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function FeedbackItem({ feedback, onChange, viewer = null, showSubject = false }) {
  const [mode, setMode] = React.useState("");
  const done = () => { setMode(""); onChange?.(); };
  return h("li", { className: "market-feedback-item", "data-market-feedback": feedback.id, "data-rating": feedback.rating }, [
    h("p", { className: "market-feedback-head", key: "head" }, [
      h("span", { className: "market-rating market-rating-" + feedback.rating, key: "rating" }, RATING_LABELS[feedback.rating] || feedback.rating),
      h("span", { className: "market-feedback-meta", key: "meta" }, [
        showSubject ? "For " : "From ",
        h(TraderLine, { key: "who", trader: showSubject ? feedback.subject : feedback.author }),
        ` · as ${feedback.role === "seller" ? "seller" : "buyer"}`,
        feedback.createdAt ? " · " + shortDate(feedback.createdAt) : "",
        feedback.editedAt ? " · edited" : "",
      ]),
    ]),
    feedback.listingTitle ? h("p", { className: "product-meta", key: "listing" }, feedback.listingTitle) : null,
    feedback.comment ? h("p", { className: "market-quote", key: "comment" }, feedback.comment) : null,
    feedback.reply ? h("p", { className: "market-feedback-reply", key: "reply" }, [h("strong", { key: "label" }, "Reply: "), feedback.reply.body]) : null,
    mode === "edit" ? h(FeedbackForm, { dealId: feedback.dealId, existing: feedback, key: "edit", onCancel: () => setMode(""), onDone: done }) : null,
    mode === "reply" ? h(ReplyForm, { feedback, key: "reply-form", onCancel: () => setMode(""), onDone: done }) : null,
    !mode && (feedback.canEdit || feedback.canReply) ? h("div", { className: "market-actions", key: "actions" }, [
      feedback.canEdit ? h("button", { className: "shop-filter-reset", key: "edit", onClick: () => setMode("edit"), type: "button" }, "Edit feedback") : null,
      feedback.canReply ? h("button", { className: "shop-filter-reset", key: "reply", onClick: () => setMode("reply"), type: "button" }, "Reply") : null,
    ]) : null,
    viewer && viewer.kind !== "public" && viewer.key && feedback.author?.key !== viewer.key && feedback.subject?.key !== viewer.key
      ? h(ReportControl, { id: feedback.id, key: "report", kind: "feedback", label: "Report feedback", viewer }) : null,
  ]);
}

export function FeedbackList({ items, empty, onChange, viewer, showSubject }) {
  if (!Array.isArray(items) || !items.length) return h("p", { className: "market-note" }, empty);
  return h("ul", { className: "market-feedback-list" }, items.map((feedback) => h(FeedbackItem, { feedback, key: feedback.id, onChange, showSubject, viewer })));
}
