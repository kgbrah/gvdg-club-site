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
