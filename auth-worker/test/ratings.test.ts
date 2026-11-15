import { describe, expect, it } from "vitest";
import { summarizeRatingRows } from "../src/ratings.js";

describe("GVDG member ratings", () => {
  it("shows legacy values as archived without estimating a rating from aggregate totals", () => {
    const group = summarizeRatingRows("competitive", [
      { id: 1, event_name: "Fall Open", event_date: "2026-09-20", place: 1, total: 54, to_par: -3, rating: 945 },
      { id: 2, event_name: "June Monthly", event_date: "2026-06-12", place: 5, total: 61, to_par: 4 },
      { id: 3, event_name: "DNF Round", event_date: "2026-05-01", place: null, total: null, to_par: null },
    ]);
    expect(group.live_rating).toBeNull();
    expect(group.rated_rounds).toBe(1);
    expect(group.rounds_count).toBe(3);
    expect(group.rounds[0]).toMatchObject({ kind: "competitive", label: "Fall Open", rating: 945, rating_method: "archived" });
    expect(group.rounds[1]).toMatchObject({ rating: null, unrated_reason: "missing-rating-evidence" });
    expect(group.rounds[2]).toMatchObject({ rating: null, unrated_reason: "incomplete-result" });
  });

  it("shows sample counts and uses the same prior-year aggregate regardless of the current history page", () => {
    const eligible = Array.from({ length: 8 }, () => ({ roundDate: "2026-05-01", roundRating: 925 }));
    const asOf = "2026-07-01T00:00:00Z";
    const row = { id: 8, round_code: "A1B2C3", finalized_at: "2026-06-25", place: 1, total: 50,
      rating: 951, source_result_id: 8, rating_method: "layout", baseline_event_id: 2, propagator_count: 3 };
    const enough = summarizeRatingRows("casual", [row], eligible, asOf);
    expect(enough).toMatchObject({ live_rating: 925, eligible_rated_rounds: 8, minimum_rated_rounds: 8 });
    expect(enough.rounds[0]).toMatchObject({ rating_method: "layout", baseline_event_id: 2, propagator_count: 3 });
    expect(summarizeRatingRows("casual", [], eligible, asOf).live_rating).toBe(925);
    expect(summarizeRatingRows("casual", [row], eligible.slice(0, 7), asOf)).toMatchObject({ live_rating: null, eligible_rated_rounds: 7 });
  });
});
