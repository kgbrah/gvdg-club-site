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
