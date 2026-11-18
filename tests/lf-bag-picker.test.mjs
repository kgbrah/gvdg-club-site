import assert from "node:assert/strict";
import test from "node:test";

import { bagDiscLabel, bagPickChoices } from "../src/public-app/lf-bag.js";

const disc = (id, record) => ({ id, revision: 1, record });
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

test("a bag disc reads like the player knows it", () => {
  assert.equal(bagDiscLabel({ brand: "Innova", model: "Destroyer", plastic: "Star", color: "Orange", weightGrams: 175.2 }), "Innova Destroyer · Star · Orange · 175 g");
  assert.equal(bagDiscLabel({ brand: "MVP", model: "Volt" }), "MVP Volt");
});

test("the picker offers bag discs first, skips archived discs and ones already reported lost, and carries their photos", () => {
  const practice = { discs: [
    disc(A, { brand: "Innova", model: "Destroyer", plastic: "Star", color: "Orange", weightGrams: 175, ink: "KG 864", inBag: true }),
    disc(B, { brand: "Axiom", model: "Envy", inBag: false }),
    disc(C, { brand: "MVP", model: "Volt", inBag: true, archived: true }),
    disc(D, { brand: "Discraft", model: "Buzzz", inBag: true }),
    disc("not-a-uuid", { brand: "X", model: "Y", inBag: true }),
  ] };
  const bag = { photos: [{ id: 7, discId: A }, { id: 8, discId: A }], lost: [{ discId: D, postId: 3, status: "open" }] };
  const choices = bagPickChoices(practice, bag);
  assert.deepEqual(choices.map((choice) => [choice.discId, choice.inBag]), [[A, true], [B, false]]);
  assert.deepEqual(choices[0].handoff, { discId: A, brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", weightG: "175", ink: "KG 864", photos: [7, 8] });
  // A lost post that's closed doesn't hide the disc.
  assert.equal(bagPickChoices(practice, { lost: [{ discId: D, status: "closed" }] }).some((choice) => choice.discId === D), true);
  assert.deepEqual(bagPickChoices(null, null), []);
});
