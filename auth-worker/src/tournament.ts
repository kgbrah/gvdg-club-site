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

export const STANDARD_DIVISION_LIMITS: Record<string, number> = {
  MA2: 934,
  MA3: 899,
  MA4: 849,
  FA2: 824,
  FA3: 774,
  FA4: 724,
};

export function isJuniorDivision(division: string | null | undefined): boolean {
  return /^[MF]J\d{1,2}$/i.test(String(division || "").trim());
}

export function isAmateurDivision(division: string | null | undefined): boolean {
  const code = String(division || "").trim().toUpperCase();
  return /^[MF]A\d+$/.test(code) || isJuniorDivision(code);
}

/** Waitlist order: when the player joined the waitlist, then lowest PDGA number, then sign-up order. */
export function waitlistOrder<T extends { waitlisted_at?: unknown; pdga_number?: unknown; id?: unknown }>(a: T, b: T): number {
  const at = String(a.waitlisted_at ?? "\uffff").localeCompare(String(b.waitlisted_at ?? "\uffff"));
  if (at) return at;
  const pdgaA = Number(a.pdga_number) || Number.MAX_SAFE_INTEGER;
  const pdgaB = Number(b.pdga_number) || Number.MAX_SAFE_INTEGER;
  return pdgaA - pdgaB || Number(a.id) - Number(b.id);
}

export type PdgaStanding = { status: string | null; rating: number | null; classification?: "P" | "A" | null };

/** The non-member fee applies unless PDGA says the player's membership is current (Junior divisions are exempt). */
export function nonMemberFeeFor(rules: TournamentRules, standing: PdgaStanding | null, division?: string | null): number {
  if (isJuniorDivision(division)) return 0;
  return rules.nonMemberFeeCents > 0 && standing?.status !== "current" ? rules.nonMemberFeeCents : 0;
}

export type EligibilityProblem =
  | { error: "pdga_membership_required" }
  | { error: "division_rating_limit"; limit: number; rating: number }
  | { error: "pdga_rating_unverified"; limit: number }
  | { error: "pro_in_amateur_division"; limit?: number; rating?: number | null }
  | { error: "pdga_check_required" };

/**
 * Whether a player may enter `division`. Enforces members-only events, PDGA 2.05 Pro-playing-Am thresholds
 * (Pros cannot play Am in Majors/ES/NT or above 969 Mixed / 869 Women's), and division rating limits (expired
 * memberships omit ratings and cannot bypass a capped division).
 */
export function eligibilityProblem(
  rules: TournamentRules,
  division: string | null,
  standing: PdgaStanding | null,
  tier?: string | null,
): EligibilityProblem | null {
  if (rules.membersOnly && standing?.status !== "current") return standing ? { error: "pdga_membership_required" } : { error: "pdga_check_required" };
  if (standing?.classification === "P" && isAmateurDivision(division)) {
    const normalizedTier = String(tier || "").trim().toUpperCase();
    if (["M", "ES", "NT", "XM"].includes(normalizedTier)) return { error: "pro_in_amateur_division" };
    const proCap = /^F/i.test(String(division || "").trim()) ? 870 : 970;
    if (standing.rating == null || standing.rating >= proCap) {
      return { error: "pro_in_amateur_division", limit: proCap - 1, rating: standing.rating };
    }
  }
  const limit = division ? rules.divisionLimits[division] : undefined;
  if (limit == null) return null;
  if (!standing) return null; // no PDGA number: unrated, which any division accepts
  if (standing.rating != null && standing.rating > limit) return { error: "division_rating_limit", limit, rating: standing.rating };
  if (standing.rating == null && standing.status !== "current") return { error: "pdga_rating_unverified", limit };
  return null;
}

/** Whether checking this registration's PDGA number matters (membership, fee, division rating cap, or Am Pro check). */
export function pdgaCheckMatters(rules: TournamentRules, division: string | null): boolean {
  return rules.membersOnly || rules.nonMemberFeeCents > 0 || Boolean(division && rules.divisionLimits[division] != null) || isAmateurDivision(division);
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

/**
 * Results for PDGA Tournament Manager's score upload (its Upload page takes rows pasted from the TD Report's Scores
 * tab, with this header row). Each club event linked to the PDGA event is one round, in date order (up to 4). Players
 * match across rounds by member id, else by name; their division and PDGA number come from their registration.
 * Places are per division over all rounds (ties share a place); a player missing a round gets no place and an empty
 * cell, for the TD to fill with PDGA's code. Owner: "results for PDGA after the event".
 */
export const PDGA_UPLOAD_HEADER = ["DivCode", "T.O.", "Place", "First Name", "Last Name", "PDGA"] as const;

export type UploadRound = { eventId: number; name: string; date: string | null };
export type UploadResult = { event_id: number; member_id: string | null; name: string; place?: number | null; total: number | null };
export type UploadRegistration = { event_id: number; member_id: string | null; name: string; division: string | null; pdga_number: string | null };

const nameKey = (name: string) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
const cell = (value: unknown) => (value == null ? "" : String(value).replace(/[\t\r\n]+/g, " ").trim());

/** PDGA's own first and last names by PDGA number (from the stored PDGA player records), for the name columns. */
export type PdgaNames = Map<string, { first: string; last: string }>;

export function pdgaResultsUpload(rounds: UploadRound[], results: UploadResult[], registrations: UploadRegistration[], pdgaNames: PdgaNames = new Map()) {
  const used = rounds.slice(0, 4);
  const roundOf = new Map(used.map((round, index) => [round.eventId, index]));
  const byMember = new Map<string, UploadRegistration>();
  const byName = new Map<string, UploadRegistration>();
  for (const reg of registrations) {
    if (reg.member_id && !byMember.has(reg.member_id)) byMember.set(reg.member_id, reg);
    const key = nameKey(reg.name);
    if (key && !byName.has(key)) byName.set(key, reg);
  }
  type Player = { name: string; division: string; pdga: string; scores: (number | null)[] };
  const players = new Map<string, Player>();
  for (const result of results) {
    const round = roundOf.get(result.event_id);
    if (round == null || !nameKey(result.name)) continue;
    const reg = (result.member_id && byMember.get(result.member_id)) || byName.get(nameKey(result.name)) || null;
    const key = result.member_id ? "m:" + result.member_id : reg?.member_id ? "m:" + reg.member_id : "n:" + nameKey(result.name);
    const player = players.get(key) ?? { name: (reg?.name || result.name).trim(), division: cell(reg?.division).toUpperCase(), pdga: cell(reg?.pdga_number), scores: used.map(() => null) };
    const total = Number(result.total);
    if (result.place !== null && Number.isFinite(total) && total > 0) player.scores[round] = total;
    players.set(key, player);
  }
  const list = [...players.values()];
  const complete = (player: Player) => player.scores.every((score) => score != null);
  const sum = (player: Player) => player.scores.reduce<number>((total, score) => total + (score ?? 0), 0);
  const places = new Map<Player, number>();
  for (const division of new Set(list.map((player) => player.division))) {
    const ranked = list.filter((player) => player.division === division && complete(player)).sort((a, b) => sum(a) - sum(b));
    ranked.forEach((player, index) => {
      const before = index > 0 ? ranked[index - 1] : undefined;
      places.set(player, before && sum(before) === sum(player) ? places.get(before) ?? index + 1 : index + 1);
    });
  }
  list.sort((a, b) => a.division.localeCompare(b.division) || (places.get(a) ?? 9999) - (places.get(b) ?? 9999) || a.name.localeCompare(b.name));
  const header = [...PDGA_UPLOAD_HEADER, ...used.map((_, index) => `Rd${index + 1}`)];
  const rows = list.map((player) => {
    // PDGA's split when it knows the number ("Steady Ed" + "Headrick"); otherwise the first word is the first name.
    const known = player.pdga ? pdgaNames.get(player.pdga) : undefined;
    const [first, ...rest] = player.name.split(/\s+/);
    const firstName = known?.first || first || "";
    const lastName = known ? known.last : rest.join(" ");
    return [player.division, "", places.get(player) ?? "", firstName, lastName, player.pdga, ...player.scores.map((score) => score ?? "")].map(cell);
  });
  return {
    header, rows,
    text: [header, ...rows].map((row) => row.join("\t")).join("\n") + "\n",
    players: list.length,
    missingScores: list.filter((player) => !complete(player)).length,
    noDivision: list.filter((player) => !player.division).length,
    noPdga: list.filter((player) => !player.pdga).length,
    extraRounds: Math.max(0, rounds.length - used.length),
  };
}

/**
 * The event's player list for PDGA Tournament Manager (its Upload page, "Upload Player Data - Basic": rows pasted from
 * the TD Report with DivCode, First Name, Last Name, PDGA; Team Name first for team events). Owner, on whether players
 * registered here show on pdga.com: "Yes please" to a copy-ready list. Paid players in field order (PDGA 1.02: entered
 * once paid), then the waitlist marked "Waitlist #N" in the Start field (PDGA's help: shown on the PDGA event page);
 * signed up but unpaid isn't registered yet, so it's left out.
 */
export type UploadPlayer = {
  id: number; name: string; division: string | null; team: string | null; pdga_number: string | null;
  paid_entry: number | null; paid_at: string | null; waitlisted: number | null; waitlisted_at: string | null;
};

export function pdgaPlayersUpload(registrations: UploadPlayer[], pdgaNames: PdgaNames = new Map()) {
  const paid = registrations.filter((row) => Number(row.paid_entry) === 1).sort(fieldOrder);
  const waitlist = registrations.filter((row) => Number(row.paid_entry) !== 1 && Number(row.waitlisted) === 1)
    .sort(waitlistOrder);
  const teams = registrations.some((row) => cell(row.team));
  const header = [...(teams ? ["Team Name"] : []), "DivCode", "First Name", "Last Name", "PDGA", ...(waitlist.length ? ["Start"] : [])];
  const line = (row: UploadPlayer, start: string) => {
    const pdga = cell(row.pdga_number);
    const known = pdga ? pdgaNames.get(pdga) : undefined;
    const [first, ...rest] = String(row.name || "").trim().split(/\s+/);
    return [
      ...(teams ? [cell(row.team)] : []),
      cell(row.division).toUpperCase(), cell(known?.first || first || ""), cell(known ? known.last : rest.join(" ")), pdga,
      ...(waitlist.length ? [start] : []),
    ];
  };
  const rows = [...paid.map((row) => line(row, "")), ...waitlist.map((row, index) => line(row, `Waitlist #${index + 1}`))];
  return {
    header, rows,
    text: [header, ...rows].map((row) => row.join("\t")).join("\n") + "\n",
    registered: paid.length,
    waitlisted: waitlist.length,
    unpaid: registrations.filter((row) => Number(row.paid_entry) !== 1 && Number(row.waitlisted) !== 1).length,
    noDivision: [...paid, ...waitlist].filter((row) => !cell(row.division)).length,
    noPdga: [...paid, ...waitlist].filter((row) => !cell(row.pdga_number)).length,
  };
}
