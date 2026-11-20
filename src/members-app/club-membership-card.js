// The Club page's GVDG membership card, under the PDGA one (owner: "Let's put GVDG Membership status under here with a
// quick PayPal app link to renew or donate to the club"). Dues and donations go to the club's PayPal.me (the PayPal
// app, through the sign-up hand-off); an admin marks the year paid once dues arrive.
import React from "react";

import { requestJson } from "./api.js";
import { useMemberContext } from "./member-context.js";
import { clubPaypalUrl } from "../shared/donate-prompt.js";
import { clubMembershipCard } from "../shared/membership-status.js";
import { SIGNUP_LINK } from "../shared/outside-link.js";

const h = React.createElement;

export function ClubMembershipCard() {
  const { membership } = useMemberContext();
  const [duesCents, setDuesCents] = React.useState(1500);
  React.useEffect(() => {
    let live = true;
    requestJson("/membership/config").then((config) => { if (live && Number(config?.duesCents) > 0) setDuesCents(Number(config.duesCents)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const card = clubMembershipCard(membership, duesCents);
  if (!card) return null;
  const amount = Number.isInteger(card.dues) ? String(card.dues) : card.dues.toFixed(2);
  return h("section", {
    className: "member-link-section player-card", "aria-label": "GVDG membership",
    "data-club-membership": card.due ? "due" : card.renewYear ? "renewable" : "settled",
  }, h("div", { className: "pdga-membership club-membership" }, [
    h("h3", { key: "title" }, "GVDG membership"),
    h("p", { className: "player-card-meta", key: "line" }, card.line),
    h("div", { className: "member-action-grid", key: "actions" }, [
      card.renewYear ? h("a", { className: `player-btn${card.due ? " primary" : ""}`, href: clubPaypalUrl(card.dues), ...SIGNUP_LINK, key: "dues",
        title: `Pay your ${card.renewYear} dues`, "aria-label": `Renew for ${card.renewYear}, $${amount}` }, `Renew · $${amount}`) : null,
      h("a", { className: "player-btn", href: clubPaypalUrl(), ...SIGNUP_LINK, key: "donate" }, "Donate"),
    ]),
    h("p", { className: "dash-note", key: "note" }, card.renewYear
      ? "Both open the club's PayPal. Add your name in the note; a club admin marks your membership once your dues are in."
      : "Opens the club's PayPal."),
  ]));
}
