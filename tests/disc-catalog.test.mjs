import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalChoice, colorName, DISC_BRANDS, DISC_COLOR_NAMES, DISC_WEIGHTS, moldsFor, parseSpokenDisc, parseSpokenSpot, plasticsFor, spokenNumbersToDigits,
} from "../src/shared/disc-catalog.js";

test("every brand lists plastics, and names are unique within a brand", () => {
  for (const brand of DISC_BRANDS) {
    assert(brand.plastics.length > 0, brand.name);
    assert.equal(new Set(brand.plastics).size, brand.plastics.length, brand.name + " plastics");
    assert.equal(new Set(brand.molds).size, brand.molds.length, brand.name + " molds");
  }
  assert.equal(new Set(DISC_BRANDS.map((brand) => brand.name)).size, DISC_BRANDS.length);
});

test("plastics and molds follow the brand", () => {
  assert(plasticsFor("Innova").includes("Star"));
  assert(!plasticsFor("Innova").includes("ESP"));
  assert(plasticsFor("discraft").includes("ESP"));
  assert(plasticsFor("").includes("Neutron") && plasticsFor("").includes("Star"));
  assert(moldsFor("Innova").includes("Destroyer"));
});

test("canonical choices and colours", () => {
  assert.equal(canonicalChoice("halo star", plasticsFor("Innova")), "Halo Star");
  assert.equal(canonicalChoice("Mystery Blend", plasticsFor("Innova")), "Mystery Blend");
  assert.equal(colorName("grey"), "Gray");
  assert.equal(colorName("tie dye"), "Tie-dye");
  assert.equal(colorName("chartreuse"), "");
  assert(DISC_COLOR_NAMES.includes("Orange"));
  assert.equal(DISC_WEIGHTS[0], 200);
  assert.equal(DISC_WEIGHTS.at(-1), 100);
});

test("spoken numbers become digits", () => {
  assert.equal(spokenNumbersToDigits("one seventy five grams"), "175 grams");
  assert.equal(spokenNumbersToDigits("one hundred and seventy two"), "172");
  assert.equal(spokenNumbersToDigits("hole seven"), "hole 7");
  assert.equal(spokenNumbersToDigits("hole twenty one"), "hole 21");
  assert.equal(spokenNumbersToDigits("hole 18"), "hole 18");
});

test("a full description fills every field", () => {
  assert.deepEqual(parseSpokenDisc("Orange Star Destroyer, 175 grams, found it on hole 7."),
    { mold: "Destroyer", plastic: "Star", brand: "Innova", color: "Orange", hole: 7, weightG: 175 });
  assert.deepEqual(parseSpokenDisc("Discraft ESP Buzz, blue, one seventy seven"),
    { mold: "Buzzz", plastic: "ESP", brand: "Discraft", color: "Blue", weightG: 177 });
  assert.deepEqual(parseSpokenDisc("it's a pink Neutron Envy from Axiom, hole twelve"),
    { mold: "Envy", plastic: "Neutron", brand: "Axiom", color: "Pink", hole: 12 });
  assert.deepEqual(parseSpokenDisc("Latitude 64 Gold Line River 168g"), { mold: "River", plastic: "Gold", brand: "Latitude 64", weightG: 168 });
  assert.deepEqual(parseSpokenDisc("gold Champion Teebird 3"), { mold: "Teebird3", plastic: "Champion", brand: "Innova", color: "Gold" });
  assert.deepEqual(parseSpokenDisc("Kastaplast K1 Berg, white"), { mold: "Berg", plastic: "K1", brand: "Kastaplast", color: "White" });
  assert.deepEqual(parseSpokenDisc("MD three in neo plastic, grey"), { mold: "MD3", plastic: "Neo", brand: "Discmania", color: "Gray" });
});

test("everyday words don't fill the form without a brand", () => {
  assert.deepEqual(parseSpokenDisc("found it off the drive, pure luck, the gold one by the river"), { color: "Gold", area: "By the river" });
  assert.deepEqual(parseSpokenDisc("mint condition, hole 30"), {}, "mint isn't Mint Discs; hole 30 doesn't exist");
  assert.deepEqual(parseSpokenDisc("Discraft Drive"), { mold: "Drive", brand: "Discraft" });
  assert.deepEqual(parseSpokenDisc(""), {});
});

test("holes stay inside the course", () => {
  assert.equal(parseSpokenDisc("hole 19", { holes: 18 }).hole, undefined);
  assert.equal(parseSpokenDisc("hole 9", { holes: 9 }).hole, 9);
});

test("where exactly: the place said in passing, without the hole or the course", () => {
  assert.equal(parseSpokenSpot("Orange Star Destroyer, 175 grams, found it on hole 7, in the pond left of the fairway."), "In the pond left of the fairway");
  assert.equal(parseSpokenSpot("found it on hole 7 by the pond"), "By the pond");
  assert.equal(parseSpokenSpot("Blue Buzzz in the woods behind the basket on hole 12"), "In the woods behind the basket");
  assert.equal(parseSpokenSpot("lost it near the creek at Elm Street"), "Near the creek");
  assert.equal(parseSpokenSpot("it was next to the parking lot"), "Next to the parking lot");
  assert.equal(parseSpokenSpot("left of the fairway past the big oak tree on 9"), "Left of the fairway past the big oak tree on 9");
  assert.equal(parseSpokenSpot("Star Destroyer in Champion plastic, hole 7"), "", "no place word: nothing");
  assert.equal(parseSpokenSpot("orange destroyer on hole 7"), "");
  assert.equal(parseSpokenSpot(""), "");
  assert(parseSpokenSpot("in the " + "very ".repeat(20) + "deep pond").length <= 48);
  assert.equal(parseSpokenDisc("Orange Star Destroyer, hole 7, in the pond").area, "In the pond");
});
