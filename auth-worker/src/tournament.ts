// Club-run PDGA events registered on the club site (no Disc Golf Scene handling fee): the event's rules, who may
// enter which division, and what a player pays. Pure; the routes do the I/O.
//
// PDGA Competition Manual 1.02: a player is entered once their entry fee is received; the field fills first come,
// first served by that time (ties: lowest PDGA number); published caps send later players to a waitlist; only paid
// players are listed publicly. 1.03: withdrawals go to the TD; refunds follow the published timeline.

export type TournamentRules = {
  /** Only current PDGA members may register (a tiering exception PDGA allows when published with registration). */
  membersOnly: boolean;
  /** Added for players who aren't current PDGA members (0 = none). */
  nonMemberFeeCents: number;
  /** Highest rating allowed per division (e.g. MA3: 899); divisions not listed have no limit. */
  divisionLimits: Record<string, number>;
};

export type FeeRates = { bps: number; fixedCents: number };

/** Disc Golf Scene's per-registration handling + transaction fee (its help pages, Nov 2026): $1.84 + 3.49%. */
export const DGS_FEE: FeeRates = { bps: 349, fixedCents: 184 };
/** PayPal Checkout's standard US rate; PAYPAL_FEE_PERCENT / PAYPAL_FEE_FIXED_CENTS override (e.g. the charity rate). */
export const PAYPAL_STANDARD_FEE: FeeRates = { bps: 349, fixedCents: 49 };

export const NO_RULES: TournamentRules = { membersOnly: false, nonMemberFeeCents: 0, divisionLimits: {} };

function centsOrZero(value: unknown, max = 100_000): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 0 && number <= max ? number : 0;
}

/** Stored rules (event_config.pdga_rules JSON), tolerant of anything malformed. */
export function parseTournamentRules(raw: unknown): TournamentRules {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ...NO_RULES, divisionLimits: {} }; }
  }
  if (!value || typeof value !== "object") return { ...NO_RULES, divisionLimits: {} };
  const row = value as Record<string, unknown>;
  const limits: Record<string, number> = {};
  if (row.divisionLimits && typeof row.divisionLimits === "object") {
    for (const [division, limit] of Object.entries(row.divisionLimits as Record<string, unknown>)) {
      const rating = Number(limit);
      if (/^[A-Za-z0-9 +-]{1,40}$/.test(division) && Number.isInteger(rating) && rating >= 300 && rating <= 1200) limits[division] = rating;
    }
  }
  return { membersOnly: row.membersOnly === true, nonMemberFeeCents: centsOrZero(row.nonMemberFeeCents), divisionLimits: limits };
}

/** Admin input for the rules; null when something is out of range (so a typo can't silently drop a limit). */
export function tournamentRulesInput(body: unknown): TournamentRules | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const fee = row.nonMemberFeeCents == null || row.nonMemberFeeCents === "" ? 0 : Number(row.nonMemberFeeCents);
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) return null;
  const limits: Record<string, number> = {};
  if (row.divisionLimits != null) {
    if (typeof row.divisionLimits !== "object" || Array.isArray(row.divisionLimits)) return null;
    for (const [division, limit] of Object.entries(row.divisionLimits as Record<string, unknown>)) {
      if (limit == null || limit === "") continue;
      const rating = Number(limit);
      if (!/^[A-Za-z0-9 +-]{1,40}$/.test(division) || !Number.isInteger(rating) || rating < 300 || rating > 1200) return null;
      limits[division] = rating;
    }
  }
  return { membersOnly: row.membersOnly === true, nonMemberFeeCents: fee, divisionLimits: limits };
}

export function paypalFeeRates(env: { PAYPAL_FEE_PERCENT?: string; PAYPAL_FEE_FIXED_CENTS?: string }): FeeRates {
  const percent = Number(env.PAYPAL_FEE_PERCENT);
  const fixed = Number(env.PAYPAL_FEE_FIXED_CENTS);
  return {
    bps: Number.isFinite(percent) && percent >= 0 && percent < 20 ? Math.round(percent * 100) : PAYPAL_STANDARD_FEE.bps,
    fixedCents: Number.isInteger(fixed) && fixed >= 0 && fixed < 500 ? fixed : PAYPAL_STANDARD_FEE.fixedCents,
  };
}

/** A processor's fee on a charge of `cents` (its percent rounded to the cent, plus the fixed part). */
export function processorFee(cents: number, rates: FeeRates): number {
  return cents > 0 ? Math.round((cents * rates.bps) / 10_000) + rates.fixedCents : 0;
}

/** The fee to add so that, after the processor takes its cut of the whole charge, the club keeps `baseCents`. */
export function coverFee(baseCents: number, rates: FeeRates): number {
  if (baseCents <= 0) return 0;
  let total = Math.ceil(((baseCents + rates.fixedCents) * 10_000) / (10_000 - rates.bps));
  while (total - processorFee(total, rates) < baseCents) total += 1;
  // PayPal rounds its percent, so the formula can land a cent high: take the smallest charge that still covers it.
  while (total - 1 - processorFee(total - 1, rates) >= baseCents) total -= 1;
  return total - baseCents;
}

/** Disc Golf Scene's fee on a registration of `cents` (what a player would have paid on top there). */
export function dgsFee(cents: number): number {
  return cents > 0 ? DGS_FEE.fixedCents + Math.ceil((cents * DGS_FEE.bps) / 10_000) : 0;
}

export type PdgaStanding = { status: string | null; rating: number | null };

/** The non-member fee applies unless PDGA says the player's membership is current. */
export function nonMemberFeeFor(rules: TournamentRules, standing: PdgaStanding | null): number {
  return rules.nonMemberFeeCents > 0 && standing?.status !== "current" ? rules.nonMemberFeeCents : 0;
}

export type EligibilityProblem =
  | { error: "pdga_membership_required" }
  | { error: "division_rating_limit"; limit: number; rating: number }
  | { error: "pdga_check_required" };

/**
 * Whether a player may enter `division`. A division with a rating limit needs the player's PDGA rating (unrated
 * players may enter it); a members-only event needs a current membership.
 */
export function eligibilityProblem(rules: TournamentRules, division: string | null, standing: PdgaStanding | null): EligibilityProblem | null {
  if (rules.membersOnly && standing?.status !== "current") return standing ? { error: "pdga_membership_required" } : { error: "pdga_check_required" };
  const limit = division ? rules.divisionLimits[division] : undefined;
  if (limit == null) return null;
  if (!standing) return null; // no PDGA number: unrated, which any division accepts
  if (standing.rating != null && standing.rating > limit) return { error: "division_rating_limit", limit, rating: standing.rating };
  return null;
}

/** Whether checking this registration's PDGA number matters (membership, a fee, or the chosen division's limit). */
export function pdgaCheckMatters(rules: TournamentRules, division: string | null): boolean {
  return rules.membersOnly || rules.nonMemberFeeCents > 0 || Boolean(division && rules.divisionLimits[division] != null);
}

export type PaymentMethod = "paypal" | "zelle" | "wallet";

export type Quote = {
  method: PaymentMethod;
  owedCents: number;        // entry + add-ons + non-member fee: what the event is owed
  feeCents: number;         // PayPal's fee the player covers (0 for Zelle and store credit, or when the club absorbs it)
  donationCents: number;    // the optional gift to the club
  totalCents: number;       // what the player pays
  savedVsDgsCents: number;  // what Disc Golf Scene would have added, less any fee here (the suggested gift)
};

/** What a player pays for `owedCents` by `method`, optionally giving the club what they saved vs Disc Golf Scene. */
export function tournamentQuote(input: {
  owedCents: number; method: PaymentMethod; donate: boolean; passthrough: boolean; rates: FeeRates; offerDonation: boolean;
}): Quote {
  const owed = Math.max(0, input.owedCents);
  const paypalFee = input.method === "paypal" && input.passthrough;
  const saved = input.offerDonation ? Math.max(0, dgsFee(owed) - (paypalFee ? coverFee(owed, input.rates) : 0)) : 0;
  const donation = input.donate ? saved : 0;
  const fee = paypalFee ? coverFee(owed + donation, input.rates) : 0;
  return { method: input.method, owedCents: owed, feeCents: fee, donationCents: donation, totalCents: owed + donation + fee, savedVsDgsCents: saved };
}

/** Field order (PDGA 1.02.5–6): when the entry fee was received, then the lowest PDGA number, then sign-up order. */
export function fieldOrder<T extends { paid_at?: unknown; pdga_number?: unknown; id?: unknown }>(a: T, b: T): number {
  const at = String(a.paid_at ?? "￿").localeCompare(String(b.paid_at ?? "￿"));
  if (at) return at;
  const pdgaA = Number(a.pdga_number) || Number.MAX_SAFE_INTEGER;
  const pdgaB = Number(b.pdga_number) || Number.MAX_SAFE_INTEGER;
  return pdgaA - pdgaB || Number(a.id) - Number(b.id);
}

/** A short memo for a Zelle payment that an admin can match against their bank (event and registration). */
export function zelleCode(eventId: number, registrationId: number): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let mix = (eventId * 7919 + registrationId * 104_729) >>> 0;
  let tail = "";
  for (let index = 0; index < 3; index++) { tail += alphabet[mix % alphabet.length]; mix = Math.floor(mix / alphabet.length); }
  return `GV${eventId}-${registrationId}${tail}`;
}
