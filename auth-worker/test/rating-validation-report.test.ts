import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { evaluateHeldOutRatings, type RatingValidationInput } from "../src/ratings-recompute-core.js";

it("reports aggregate validation evidence or states that no field data was supplied", () => {
  const processEnv = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const filename = processEnv?.GVDG_RATING_VALIDATION_INPUT;
  const input: RatingValidationInput = filename ? JSON.parse(readFileSync(filename, "utf8")) : {
    cutoff: new Date().toISOString(), anchors: [], calibrationFields: [], heldOutRounds: [],
  };
  const report = evaluateHeldOutRatings(input);
  if (filename) console.log(JSON.stringify(report, null, 2));
  else expect(report).toMatchObject({ status: "no-data", evaluatedRounds: 0, meanAbsoluteErrorStrokes: null });
});
