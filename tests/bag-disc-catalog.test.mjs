import assert from "node:assert/strict";
import test from "node:test";

import { discCatalog, discChoiceKey, discChoices, parseSpokenDisc, unfilledDiscDetails } from "../src/members-app/bag-disc-catalog.js";

const saved = { record: { brand: "North Flight", model: "Starling V2", plastic: "Cloud Flex" } };
const catalog = discCatalog([saved]);

test("bag suggestions follow the brand and model and include the owner's custom entries", () => {
  const axiom = discChoices(catalog, "axiom", "Envy");
  assert(axiom.models.includes("Hex"));
  assert(axiom.plastics.includes("Electron"));
  assert(!axiom.models.includes("Glitch"));
  assert(!axiom.plastics.includes("Star"));
  assert.deepEqual(discChoices(catalog, "MVP", "Glitch").plastics, ["Neutron Soft"]);
  assert.deepEqual(discChoices(catalog, "Innova", "Envy").plastics, []);
  assert(discChoices(catalog, "Innova", "Tee Bird").plastics.includes("Champion"));
  assert(discChoices(catalog, "Latitude 64°", "Grace").plastics.includes("Grand"));
  const custom = discChoices(catalog, "North Flight", "Starling V2");
  assert(custom.brands.includes("North Flight"));
  assert.deepEqual(custom.models, ["Starling V2"]);
  assert.deepEqual(custom.plastics, ["Cloud Flex"]);
  assert(!discChoices(discCatalog(), "", "").brands.includes("North Flight"));
  assert.equal(discChoiceKey("Fábrica"), discChoiceKey("FABRICA"));
});

test("spoken bag details recognize a catalog combo, decimal and word-number weights", () => {
  assert.deepEqual(parseSpokenDisc("Innova Halo Star Destroyer, 175 grams", catalog, {}), {
    brand: "Innova", model: "Destroyer", plastic: "Halo Star", weightGrams: "175",
  });
  assert.deepEqual(parseSpokenDisc("Mako three in Champion, one seventy five point five grams", catalog, {}), {
    brand: "Innova", model: "Mako3", plastic: "Champion", weightGrams: "175.5",
  });
  assert.deepEqual(parseSpokenDisc("MVP Glitch Neutron Soft one hundred and fifty grams", catalog, {}), {
    brand: "MVP", model: "Glitch", plastic: "Neutron Soft", weightGrams: "150",
  });
  assert.deepEqual(parseSpokenDisc("brand Moonworks, model Owl X, plastic Soft Blend, weight 166.4 grams", catalog, {}), {
    brand: "Moonworks", model: "Owl X", plastic: "Soft Blend", weightGrams: "166.4",
  });
  assert.equal(parseSpokenDisc("North Flight Starling V2 Cloud Flex 170g", catalog, {}).plastic, "Cloud Flex");
  assert.equal(parseSpokenDisc("Innova Champion Tee Bird 168.5", catalog, {}).weightGrams, "168.5");
});

test("voice does not fill the wrong manufacturer, model or out-of-range weight", () => {
  const conflict = parseSpokenDisc("Axiom Envy Electron, 173 grams", catalog, { brand: "Innova" });
  assert.deepEqual(unfilledDiscDetails({ brand: "Innova" }, conflict), {});
  assert.deepEqual(unfilledDiscDetails({ brand: "Innova", model: "Destroyer", plastic: "My blend", notes: "Keep", inBag: false },
    parseSpokenDisc("Innova Star Destroyer 175 grams", catalog, {})), { weightGrams: "175" });
  assert.equal(parseSpokenDisc("MVP Envy Electron", catalog, {}).model, "");
  assert.equal(parseSpokenDisc("Axiom Hex Electron", catalog, {}).plastic, "");
  for (const text of ["Mako 3", "you heard a disc", "two hundred fifty grams", "39 g", "-175 g", "175.23 g"]) {
    assert.equal(parseSpokenDisc(text, catalog, {}).weightGrams, "", text);
  }
});
