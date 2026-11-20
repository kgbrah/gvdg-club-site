// The Club page's GVDG membership card, under the PDGA one (owner: "Let's put GVDG Membership status under here with a
// quick PayPal app link to renew or donate to the club"). Dues and donations go to the club's PayPal.me (the PayPal
// app, through the sign-up hand-off); an admin marks the year paid once dues arrive.
// Donations earn +10 karma a dollar once an admin confirms them (owner: "Let's make ALL donations reward +10 karma per
// dollar"): after tapping Donate, or with "Record a donation" for a gift made anywhere else, the member tells the club.
import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { useMemberContext } from "./member-context.js";
import { DonationReport, KARMA_PER_DOLLAR, clubPaypalUrl } from "../shared/donate-prompt.js";
import { clubMembershipCard } from "../shared/membership-status.js";
import { SIGNUP_LINK } from "../shared/outside-link.js";

const h = React.createElement;

const money = (cents) => "$" + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

function donationLine(row) {
  if (row.status === "confirmed") return `${money(row.amountCents)} · +${row.karma} karma. Thank you!`;
  if (row.status === "not_received") return `${money(row.amountCents)} · the club didn't find it in PayPal`;
  return `${money(row.amountCents)} · waiting for the club to confirm`;
}

export function ClubMembershipCard() {
  const { membership } = useMemberContext();
  const [duesCents, setDuesCents] = React.useState(1500);
  const [reporting, setReporting] = React.useState(false);
  const [donations, setDonations] = React.useState([]);
  const loadDonations = React.useCallback(() => {
    const token = storageGet(TOKEN_KEY);
    if (!token) return;
    requestJson("/me/donations", { token }).then((data) => setDonations(Array.isArray(data?.donations) ? data.donations.slice(0, 3) : [])).catch(() => {});
  }, []);
  React.useEffect(() => {
    let live = true;
    requestJson("/membership/config").then((config) => { if (live && Number(config?.duesCents) > 0) setDuesCents(Number(config.duesCents)); }).catch(() => {});
    loadDonations();
    return () => { live = false; };
  }, [loadDonations]);
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
      h("a", { className: "player-btn", href: clubPaypalUrl(), ...SIGNUP_LINK, key: "donate", onClick: () => setReporting(true) }, "Donate"),
    ]),
    h("p", { className: "dash-note", key: "note" }, card.renewYear
      ? `Both open the club's PayPal. Add your name in the note; a club admin marks your membership once your dues are in. Donations earn +${KARMA_PER_DOLLAR} karma a dollar.`
      : `Opens the club's PayPal. Donations earn +${KARMA_PER_DOLLAR} karma a dollar.`),
    reporting
      ? h(DonationReport, { source: "club-card", key: "report", onDone: loadDonations })
      : h("button", { type: "button", className: "dash-link-btn", key: "record", onClick: () => setReporting(true) }, "Gave already? Record a donation"),
    donations.length ? h("ul", { className: "donation-history", "aria-label": "Your donations", key: "history" },
      donations.map((row) => h("li", { key: row.id }, donationLine(row)))) : null,
  ]));
}
