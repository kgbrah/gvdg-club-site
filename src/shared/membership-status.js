/** Account and home copy for the membership object returned by /me and /login. */

export function membershipAccountLine(membership) {
  if (!membership || !Number.isInteger(membership.throughYear)) return "";
  if (membership.guest) return "Guest account: play, score, register for events and buy. Ask a club admin about membership to sell in the marketplace.";
  if (membership.lapsed) return "Membership lapsed on January 1. Ask a club admin to renew.";
  if (membership.remind && Number.isInteger(membership.renewalYear)) {
    return `Renew by January 1 for ${membership.renewalYear}. A club admin marks it once dues are in.`;
  }
  return `Member through December 31, ${membership.throughYear}.`;
}

export function membershipHomeHint(membership) {
  if (!membership || !Number.isInteger(membership.throughYear)) return "";
  if (membership.guest) return "";
  if (membership.lapsed) return "Lapsed January 1. Ask an admin to renew.";
  if (membership.remind) return "Renew by January 1.";
  return "";
}

/**
 * The Club page's GVDG membership card (owner: "put GVDG Membership status under here with a quick PayPal app link to
 * renew or donate to the club"): the status line, which year the dues link pays for (none once paid through next
 * year, and for guests), and whether renewing is due now (lapsed, or the December reminder).
 */
export function clubMembershipCard(membership, duesCents = 1500) {
  if (!membership || !Number.isInteger(membership.throughYear)) return null;
  const dues = Math.round(Number(duesCents) > 0 ? Number(duesCents) : 1500) / 100;
  if (membership.guest) {
    return { line: "Guest account. Ask a club admin about becoming a member.", renewYear: null, due: false, dues };
  }
  const renewYear = membership.lapsed ? (membership.renewalYear ?? membership.currentYear ?? null) : membership.renewalYear ?? null;
  const due = Boolean(membership.lapsed || (membership.remind && renewYear));
  const line = membership.lapsed ? "Your membership lapsed on January 1."
    : membership.remind && renewYear ? `Member through December 31, ${membership.throughYear}. Renew by January 1 for ${renewYear}.`
      : `Member through December 31, ${membership.throughYear}.`;
  return { line, renewYear, due, dues };
}
