// A starter set of manufacturer-listed combinations. Saved entries add this
// member's own choices. These lists offer suggestions and never restrict a save.
// Sources: innovadiscs.com/disc/{aviar,destroyer,mako3,teebird,teebird3,wraith}/
// discgolf.discraft.com/forms/customgolfdiscs.pdf
// axiomdiscs.com/discs/{envy,hex,proxy}/
// mvpdiscsports.com/discs/{glitch,wave}/
// latitude64.com/products/6-disc-set-stock-favorites
const STARTER = {
  Innova: {
    Aviar: ["DX", "Star", "Champion", "R-Pro", "XT", "Halo Star"],
    Destroyer: ["Star", "Champion", "DX", "GStar", "Pro", "Halo Star"],
    Mako3: ["Star", "Champion", "DX", "GStar", "XT", "Halo Star"],
    TeeBird: ["Star", "Champion", "DX", "GStar"],
    TeeBird3: ["Star", "Champion", "DX", "GStar"],
    Wraith: ["Star", "Champion", "DX", "GStar", "Pro", "Halo Star"],
  },
  Discraft: {
    Buzzz: ["ESP", "Z"],
    Heat: ["Z", "Z Lite"],
    Undertaker: ["ESP"],
    Zone: ["ESP", "Jawbreaker"],
  },
  Axiom: {
    Envy: ["Neutron", "Electron", "Proton", "Plasma", "Eclipse"],
    Hex: ["Neutron", "Cosmic Neutron"],
    Proxy: ["Neutron", "Electron"],
  },
  MVP: {
    Glitch: ["Neutron Soft"],
    Wave: ["Neutron", "Fission", "Plasma"],
  },
  "Latitude 64": {
    Explorer: ["Opto"],
    Fuse: ["Opto", "Gold"],
    Grace: ["Grand"],
    Pure: ["Zero Medium"],
    River: ["Opto", "Gold"],
  },
};

const alias = {
  Axiom: ["axiom discs"],
  Discraft: ["disc craft"],
  MVP: ["m v p", "mvp disc sports"],
  "Latitude 64": ["latitude sixty four", "latitude 64 degrees"],
  Mako3: ["mako 3", "mako three"],
  TeeBird: ["tee bird", "tea bird"],
  TeeBird3: ["tee bird 3", "tee bird three", "teebird 3"],
  Buzzz: ["buzz"],
  GStar: ["g star"],
  "R-Pro": ["r pro"],
  DX: ["d x"],
  ESP: ["e s p"],
};

function spokenWords(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function discChoiceKey(value) {
  const words = spokenWords(value).replace(/^(latitude) sixty four$/, "$1 64");
  return words.replaceAll(" ", "");
}

function uniqueChoices(strings) {
  const choices = new Map();
  for (const value of strings) {
    const key = discChoiceKey(value);
    if (key && !choices.has(key)) choices.set(key, value.trim());
  }
  return [...choices.values()].sort((a, b) => a.localeCompare(b));
}

const defaults = Object.entries(STARTER).flatMap(([brand, molds]) =>
  Object.entries(molds).flatMap(([model, plastics]) => plastics.map((plastic) => ({ brand, model, plastic }))));

export function discCatalog(savedDiscs = []) {
  return [...defaults, ...savedDiscs.map(({ record }) => record).filter((record) => record?.brand && record?.model)];
}

export function discChoices(catalog, brand, model) {
  const forBrand = catalog.filter((item) => discChoiceKey(item.brand) === discChoiceKey(brand));
  return {
    brands: uniqueChoices(catalog.map((item) => item.brand)),
    models: uniqueChoices(forBrand.map((item) => item.model)),
    plastics: uniqueChoices(forBrand.filter((item) => discChoiceKey(item.model) === discChoiceKey(model)).map((item) => item.plastic)),
  };
}

function matchSpoken(text, values) {
  const candidates = values.flatMap((value) => [value, ...(Object.hasOwn(alias, value) ? alias[value] : [])]
    .map((phrase) => ({ value, phrase: spokenWords(phrase) })));
  return candidates.sort((a, b) => b.phrase.length - a.phrase.length)
    .find(({ phrase }) => phrase && text.includes(" " + phrase + " "))?.value;
}

const units = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function integerWords(words) {
  if (!words.length) return null;
  if (words.length === 1 && /^\d+$/.test(words[0])) return Number(words[0]);
  if (words.every((word) => units.includes(word))) return Number(words.map((word) => units.indexOf(word)).join(""));
  let hundreds = 0;
  const hundredsDigit = units.indexOf(words[0]);
  if (hundredsDigit > 0 && words[1] === "hundred") {
    hundreds = hundredsDigit * 100;
    words = words.slice(words[2] === "and" ? 3 : 2);
  } else if (hundredsDigit > 0 && words.length > 1 && (tens.includes(words[1]) || teens.includes(words[1]))) {
    hundreds = hundredsDigit * 100;
    words = words.slice(1);
  }
  if (!words.length) return hundreds;
  if (words.length === 1 && units.includes(words[0])) return hundreds + units.indexOf(words[0]);
  if (words.length === 1 && teens.includes(words[0])) return hundreds + 10 + teens.indexOf(words[0]);
  const tensDigit = tens.indexOf(words[0]);
  const onesDigit = words.length === 2 ? units.indexOf(words[1]) : 0;
  return tensDigit >= 2 && onesDigit >= 0 && words.length <= 2 ? hundreds + tensDigit * 10 + onesDigit : null;
}

function grams(text) {
  const cleaned = text.trim().replace(/(?:\s*(?:grams?|g))\.?$/i, "").trim();
  const [whole, fraction, extra] = spokenWords(cleaned).split(" point ");
  let number = /^-?\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : integerWords(whole.split(" "));
  if (extra || (fraction && !fraction.split(" ").every((word) => units.includes(word) || /^\d$/.test(word)))) return null;
  if (number != null && fraction) number += Number("0." + fraction.split(" ").map((word) =>
    units.includes(word) ? units.indexOf(word) : word).join(""));
  return number;
}

function validWeight(number) {
  return number != null && number >= 40 && number <= 220 && Number(number.toFixed(1)) === number ? String(number) : "";
}

function findWeight(text, explicitWeight, modelKnown) {
  if (explicitWeight) return validWeight(grams(explicitWeight));
  const negativeBefore = (match) => /\b(?:minus|negative)\s*$/i.test(text.slice(0, match.index));
  const numeric = text.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*(?:grams?|g)\b/i);
  if (numeric) return negativeBefore(numeric) ? "" : validWeight(grams(numeric[1]));
  const beforeUnits = text.split(/\bgrams?\b/i);
  if (beforeUnits.length < 2) {
    const lastNumber = modelKnown && text.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*[.!?]?$/);
    return lastNumber && !negativeBefore(lastNumber) ? validWeight(grams(lastNumber[1])) : "";
  }
  const words = spokenWords(beforeUnits[0]).split(" ");
  // Start with the longest supported phrase so “one hundred seventy five”
  // never falls through to the shorter and unrelated “seventy five”.
  for (let length = Math.min(words.length, 8); length > 0; length--) {
    const value = grams(words.slice(-length).join(" "));
    if (value != null) return ["minus", "negative"].includes(words.at(-length - 1)) ? "" : validWeight(value);
  }
  return "";
}

function namedFields(text) {
  const content = text.replace(/^\s*(?:add (?:a |the )?(?:disc\s*)?)?/i, "");
  if (!/^(?:brand|model|plastic|weight)\b/i.test(content)) return {};
  const clauses = content.split(/[,;]/).map((clause) => clause.trim()).filter(Boolean);
  const fieldsFound = clauses.length > 1
    ? clauses.map((clause) => clause.match(/^(brand|model|plastic|weight)(?:\s*:\s*|\s+)(.+)$/i)).filter(Boolean)
    : content.matchAll(/\b(brand|model|plastic|weight)(?:\s*:\s*|\s+)([^,;]+?)(?=\s+(?:brand|model|plastic|weight)\b|[,;]|$)/gi);
  const fields = {};
  for (const [, key, value] of fieldsFound) {
    const cleaned = value.trim().replace(/[.!?]+$/, "");
    if (cleaned.length <= 80) fields[key.toLowerCase()] = cleaned;
  }
  // Recognition can leave Brand and Model together before the first comma.
  // Keep clause values whole when they already include a separate Model field.
  if (clauses.length > 1 && fields.brand && !fields.model) {
    const identity = fields.brand.match(/^(.+?)\s+model(?:\s*:\s*|\s+)(.+)$/i);
    if (identity) {
      fields.brand = identity[1].trim();
      fields.model = identity[2].trim();
    }
  }
  return fields;
}

export function parseSpokenDisc(transcript, catalog, current) {
  const literal = namedFields(transcript);
  const text = " " + spokenWords(transcript) + " ";
  const allBrands = uniqueChoices(catalog.map((item) => item.brand));
  const allModels = uniqueChoices(catalog.map((item) => item.model));
  const brand = literal.brand || matchSpoken(text, allBrands) || "";
  const suppliedBrand = brand || current.brand;
  const models = suppliedBrand ? discChoices(catalog, suppliedBrand).models : allModels;
  const model = literal.model || matchSpoken(text, models) || "";
  const modelName = model || current.model;
  const matchingBrands = modelName ? uniqueChoices(catalog.filter((item) => discChoiceKey(item.model) === discChoiceKey(modelName)).map((item) => item.brand)) : [];
  const inferredBrand = matchingBrands.length === 1 && model && !suppliedBrand ? matchingBrands[0] : "";
  const plastics = discChoices(catalog, suppliedBrand || inferredBrand, modelName).plastics;
  return {
    brand: brand || inferredBrand,
    model,
    plastic: literal.plastic || matchSpoken(text, plastics) || "",
    weightGrams: findWeight(transcript, literal.weight, Boolean(modelName)),
  };
}

export function unfilledDiscDetails(form, suggested) {
  const sameOrEmpty = (field) => !form[field] || !suggested[field] || discChoiceKey(form[field]) === discChoiceKey(suggested[field]);
  const fields = sameOrEmpty("brand") && sameOrEmpty("model") ? ["brand", "model", "plastic", "weightGrams", "color"] : [];
  return Object.fromEntries(fields.filter((field) => !String(form[field] ?? "").trim() && suggested[field])
    .map((field) => [field, suggested[field]]));
}
