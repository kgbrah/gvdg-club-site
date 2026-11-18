// Round history and stats come with a club membership. Guest accounts get them as a promotion for the first 100
// approved guests; after that a guest sees this card instead (the Worker answers those reads with membership_required).
import React from "react";

const h = React.createElement;

/** True for a guest account without a promo spot. */
export function historyLocked(context) {
  return context?.membership?.guest === true && context.membership.history === false;
}

export function MembershipNeeded({ what = "Round history and stats" }) {
  return h("section", { className: "player-card", "data-membership-needed": "true" }, [
    h("h3", { key: "title" }, `${what} come with a club membership`),
    h("p", { className: "player-card-meta", key: "copy" },
      "Your guest account lets you sign up for events, keep score, post in Lost & Found and buy in the marketplace. Ask a club admin about becoming a member to see your rounds, ratings and stats."),
  ]);
}
