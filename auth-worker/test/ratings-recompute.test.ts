import { describe, expect, it } from "vitest";
import { evaluateHeldOutRatings, type RatingValidationInput } from "../src/ratings-recompute-core.js";

const A = "geometry-v1:" + "a".repeat(64);
const B = "geometry-v1:" + "b".repeat(64);
const C = "geometry-v1:" + "c".repeat(64);
const members = Array.from({ length: 10 }, (_, index) => ({ memberId: "m_" + index, rating: 1000 }));

function samples(): RatingValidationInput {
  const anchors = members.map((member) => ({ ...member, observedAt: "2026-01-04", effectiveAt: "2026-01-03" }));
  const calibrationFields = [
    { eventId: 1, layoutRevision: A, playedAt: "2026-02-01", availableAt: "2026-02-02", results: members.map(({ memberId }) => ({ memberId, total: 55 })) },
    { eventId: 2, layoutRevision: B, playedAt: "2026-03-01", availableAt: "2026-03-02", results: members.map(({ memberId }) => ({ memberId, total: 60 })) },
  ];
  const heldOutRounds = members.flatMap(({ memberId }) => [
    { memberId, layoutRevision: A, playedAt: "2026-05-02", total: 57 },
    { memberId, layoutRevision: B, playedAt: "2026-05-06", total: 62 },
    { memberId, layoutRevision: B, playedAt: "2026-06-20", total: 60 },
  ]);
  return { cutoff: "2026-05-01", anchors, calibrationFields, heldOutRounds };
}

describe("chronological rating validation", () => {
  it("withholds measurements until sufficient independent rounds, players, and layouts are eligible", () => {
    const data = samples();
    expect(evaluateHeldOutRatings({ ...data, heldOutRounds: [] })).toMatchObject({ status: "no-data", meanAbsoluteErrorStrokes: null });
    expect(evaluateHeldOutRatings({ ...data, heldOutRounds: data.heldOutRounds.slice(0, 2) })).toMatchObject({
      status: "insufficient-sample", evaluatedRounds: 2, evaluatedLayoutRevisions: 2, meanAbsoluteErrorStrokes: null,
    });
  });

  it("does not use outcomes, ratings observed after the cutoff, late-published fields, or a changed pin", () => {
    const data = samples();
    const baseline = evaluateHeldOutRatings(data);
    const poisons = {
      ...data,
      anchors: [...data.anchors, ...members.map((member) => ({ ...member, rating: 1250, observedAt: "2026-06-01", effectiveAt: "2026-01-05" }))],
      calibrationFields: [...data.calibrationFields,
        { ...data.calibrationFields[0]!, eventId: 3, playedAt: "2026-04-30", availableAt: "2026-05-02", results: members.map(({ memberId }) => ({ memberId, total: 75 })) },
        { ...data.calibrationFields[1]!, eventId: 4, playedAt: "2026-05-04", availableAt: "2026-05-04", results: members.map(({ memberId }) => ({ memberId, total: 80 })) }],
      heldOutRounds: [...data.heldOutRounds, { ...data.heldOutRounds[0]!, layoutRevision: C, total: 110 }],
    };
    expect(evaluateHeldOutRatings(poisons)).toMatchObject({
      status: "measured", evaluatedRounds: 30, evaluatedPlayers: 10, evaluatedLayoutRevisions: 2,
      excluded: { noLayoutBaseline: 1 }, meanAbsoluteErrorStrokes: baseline.meanAbsoluteErrorStrokes,
      meanBiasStrokes: baseline.meanBiasStrokes,
    });
    expect(baseline.meanAbsoluteErrorStrokes).toBe(1.33);
  });
});
