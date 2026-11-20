import { describe, expect, it } from "vitest";
import {
  coverFee, dgsFee, eligibilityProblem, fieldOrder, nonMemberFeeFor, parseTournamentRules, paypalFeeRates, pdgaCheckMatters, processorFee,
  tournamentQuote, tournamentRulesInput, zelleCode, PAYPAL_STANDARD_FEE,
} from "../src/tournament.js";

describe("what a tournament player pays", () => {
  it("covers PayPal's fee so the club keeps the whole entry, to the cent, for every amount", () => {
    for (let base = 100; base <= 30_000; base += 37) {
      const fee = coverFee(base, PAYPAL_STANDARD_FEE);
      const total = base + fee;
      expect(total - processorFee(total, PAYPAL_STANDARD_FEE)).toBeGreaterThanOrEqual(base);
      expect(total - 1 - processorFee(total - 1, PAYPAL_STANDARD_FEE)).toBeLessThan(base); // and not a cent more
    }
    expect(coverFee(5000, PAYPAL_STANDARD_FEE)).toBe(232); // $50 entry: $52.32, PayPal keeps $2.32
    expect(coverFee(0, PAYPAL_STANDARD_FEE)).toBe(0);
    expect(paypalFeeRates({ PAYPAL_FEE_PERCENT: "1.99", PAYPAL_FEE_FIXED_CENTS: "49" })).toEqual({ bps: 199, fixedCents: 49 });
    expect(paypalFeeRates({ PAYPAL_FEE_PERCENT: "nope" })).toEqual(PAYPAL_STANDARD_FEE);
  });

  it("suggests giving the club what Disc Golf Scene would have charged, less any PayPal fee here", () => {
    const rates = PAYPAL_STANDARD_FEE;
    expect(dgsFee(5000)).toBe(184 + 175);
    const paypal = tournamentQuote({ owedCents: 5000, method: "paypal", donate: false, passthrough: true, rates, offerDonation: true });
    expect(paypal).toEqual({ method: "paypal", owedCents: 5000, feeCents: 232, donationCents: 0, totalCents: 5232, savedVsDgsCents: 127 });
    const gives = tournamentQuote({ owedCents: 5000, method: "paypal", donate: true, passthrough: true, rates, offerDonation: true });
    expect(gives.donationCents).toBe(127);
    expect(gives.totalCents - processorFee(gives.totalCents, rates)).toBeGreaterThanOrEqual(5000 + 127);
    const zelle = tournamentQuote({ owedCents: 5000, method: "zelle", donate: true, passthrough: true, rates, offerDonation: true });
    expect(zelle).toEqual({ method: "zelle", owedCents: 5000, feeCents: 0, donationCents: 359, totalCents: 5359, savedVsDgsCents: 359 });
    const absorbed = tournamentQuote({ owedCents: 5000, method: "paypal", donate: false, passthrough: false, rates, offerDonation: true });
    expect(absorbed).toMatchObject({ feeCents: 0, totalCents: 5000, savedVsDgsCents: 359 });
    expect(tournamentQuote({ owedCents: 5000, method: "paypal", donate: true, passthrough: true, rates, offerDonation: false }))
      .toMatchObject({ donationCents: 0, savedVsDgsCents: 0, totalCents: 5232 });
  });
});

describe("tournament rules", () => {
  const rules = parseTournamentRules(JSON.stringify({ membersOnly: false, nonMemberFeeCents: 1000, divisionLimits: { MA3: 899, MA4: 849, "bad div!": 900, MA1: 5000 } }));

  it("reads stored rules and keeps only sensible limits", () => {
    expect(rules).toEqual({ membersOnly: false, nonMemberFeeCents: 1000, divisionLimits: { MA3: 899, MA4: 849 } });
    expect(parseTournamentRules("not json")).toEqual({ membersOnly: false, nonMemberFeeCents: 0, divisionLimits: {} });
    expect(tournamentRulesInput({ membersOnly: true, nonMemberFeeCents: "1000", divisionLimits: { MA3: "899", MA1: "" } }))
      .toEqual({ membersOnly: true, nonMemberFeeCents: 1000, divisionLimits: { MA3: 899 } });
    expect(tournamentRulesInput({ divisionLimits: { MA3: 2000 } })).toBeNull();
    expect(tournamentRulesInput({ nonMemberFeeCents: -5 })).toBeNull();
  });

  it("checks division limits and membership, and charges non-members the fee", () => {
    expect(eligibilityProblem(rules, "MA3", { status: "current", rating: 905 })).toEqual({ error: "division_rating_limit", limit: 899, rating: 905 });
    expect(eligibilityProblem(rules, "MA3", { status: "current", rating: 899 })).toBeNull();
    expect(eligibilityProblem(rules, "MA3", { status: "current", rating: null })).toBeNull(); // unrated
    expect(eligibilityProblem(rules, "MA3", null)).toBeNull(); // no PDGA number: unrated
    expect(eligibilityProblem(rules, "MPO", { status: "current", rating: 1030 })).toBeNull();
    const members = { ...rules, membersOnly: true };
    expect(eligibilityProblem(members, "MPO", { status: "expired", rating: null })).toEqual({ error: "pdga_membership_required" });
    expect(eligibilityProblem(members, "MPO", null)).toEqual({ error: "pdga_check_required" });
    expect(nonMemberFeeFor(rules, { status: "current", rating: 900 })).toBe(0);
    expect(nonMemberFeeFor(rules, { status: "expired", rating: null })).toBe(1000);
    expect(nonMemberFeeFor(rules, null)).toBe(1000);
    expect(pdgaCheckMatters({ ...rules, nonMemberFeeCents: 0 }, "MPO")).toBe(false);
    expect(pdgaCheckMatters({ ...rules, nonMemberFeeCents: 0 }, "MA3")).toBe(true);
  });

  it("orders the field by when the fee was received, then the lowest PDGA number (PDGA 1.02.5-6)", () => {
    const rows = [
      { id: 1, paid_at: "2026-11-19T10:00:00.000Z", pdga_number: "90000" },
      { id: 2, paid_at: "2026-11-19T09:00:00.000Z", pdga_number: "120000" },
      { id: 3, paid_at: "2026-11-19T10:00:00.000Z", pdga_number: "8000" },
      { id: 4, paid_at: null, pdga_number: "1" },
    ];
    expect([...rows].sort(fieldOrder).map((row) => row.id)).toEqual([2, 3, 1, 4]);
    expect(zelleCode(42, 7)).toMatch(/^GV42-7[A-Z2-9]{3}$/);
    expect(zelleCode(42, 7)).toBe(zelleCode(42, 7));
  });
});

describe("pdgaResultsUpload", () => {
  it("places each division over all rounds (ties share a place) and leaves players missing a round unplaced", async () => {
    const { pdgaResultsUpload } = await import("../src/tournament.js");
    const upload = pdgaResultsUpload(
      [{ eventId: 1, name: "R1", date: "2099-01-01" }],
      [
        { event_id: 1, member_id: "a", name: "Ann Lee", total: 60 },
        { event_id: 1, member_id: "b", name: "Bo", total: 58 },
        { event_id: 1, member_id: "c", name: "Cal Ray Jr", total: 60 },
        { event_id: 1, member_id: "d", name: "Dee Dee", total: null },
        { event_id: 2, member_id: "a", name: "Ann Lee", total: 40 },
      ],
      [{ event_id: 1, member_id: "a", name: "Ann Lee", division: "ma1", pdga_number: "1" }, { event_id: 1, member_id: "c", name: "Cal Ray Jr", division: "MA1", pdga_number: "3" }],
    );
    expect(upload.rows).toEqual([
      ["", "", "1", "Bo", "", "", "58"],
      ["", "", "", "Dee", "Dee", "", ""],
      ["MA1", "", "1", "Ann", "Lee", "1", "60"],
      ["MA1", "", "1", "Cal", "Ray Jr", "3", "60"],
    ]);
    expect(upload).toMatchObject({ players: 4, missingScores: 1, noDivision: 2, noPdga: 2 });
    // PDGA's own first/last split when it knows the number ("Steady Ed" + "Headrick", not "Steady" + "Ed Headrick").
    const named = pdgaResultsUpload([{ eventId: 1, name: "R1", date: null }], [{ event_id: 1, member_id: "e", name: "Steady Ed Headrick", total: 61 }],
      [{ event_id: 1, member_id: "e", name: "Steady Ed Headrick", division: "MPO", pdga_number: "1" }], new Map([["1", { first: "Steady Ed", last: "Headrick" }]]));
    expect(named.rows[0]).toEqual(["MPO", "", "1", "Steady Ed", "Headrick", "1", "61"]);
  });
});

describe("pdgaPlayersUpload", () => {
  const row = (over: Record<string, unknown>) => ({ id: 1, name: "X", division: "MPO", team: null, pdga_number: null, paid_entry: 0, paid_at: null, waitlisted: 0, waitlisted_at: null, ...over });
  it("lists paid players in field order, then the waitlist as Waitlist #N; unpaid sign-ups aren't registered yet", async () => {
    const { pdgaPlayersUpload } = await import("../src/tournament.js");
    const upload = pdgaPlayersUpload([
      row({ id: 1, name: "Late Payer", pdga_number: "200", paid_entry: 1, paid_at: "2026-11-10T12:00:00Z" }),
      row({ id: 2, name: "Steady Ed Headrick", pdga_number: "1", paid_entry: 1, paid_at: "2026-11-02T12:00:00Z", division: "mpo" }),
      row({ id: 3, name: "Tie Low", pdga_number: "50", paid_entry: 1, paid_at: "2026-11-10T12:00:00Z" }),
      row({ id: 4, name: "Wait Two", waitlisted: 1, waitlisted_at: "2026-11-12T00:00:00Z", division: "MA3" }),
      row({ id: 5, name: "Wait One", pdga_number: "77", waitlisted: 1, waitlisted_at: "2026-11-11T00:00:00Z", division: "MA3" }),
      row({ id: 6, name: "Not Paid", pdga_number: "88" }),
    ], new Map([["1", { first: "Steady Ed", last: "Headrick" }]]));
    expect(upload.header).toEqual(["DivCode", "First Name", "Last Name", "PDGA", "Start"]);
    expect(upload.rows).toEqual([
      ["MPO", "Steady Ed", "Headrick", "1", ""],
      ["MPO", "Tie", "Low", "50", ""],
      ["MPO", "Late", "Payer", "200", ""],
      ["MA3", "Wait", "One", "77", "Waitlist #1"],
      ["MA3", "Wait", "Two", "", "Waitlist #2"],
    ]);
    expect(upload).toMatchObject({ registered: 3, waitlisted: 2, unpaid: 1, noDivision: 0, noPdga: 1 });
    expect(upload.text.split("\n")[0]).toBe("DivCode\tFirst Name\tLast Name\tPDGA\tStart");
  });
  it("team events put Team Name first; no Start column without a waitlist", async () => {
    const { pdgaPlayersUpload } = await import("../src/tournament.js");
    const upload = pdgaPlayersUpload([row({ id: 1, name: "Ann Lee", team: "Birdie Bros", pdga_number: "9", paid_entry: 1, paid_at: "2026-11-01" })]);
    expect(upload.header).toEqual(["Team Name", "DivCode", "First Name", "Last Name", "PDGA"]);
    expect(upload.rows).toEqual([["Birdie Bros", "MPO", "Ann", "Lee", "9"]]);
  });
});
