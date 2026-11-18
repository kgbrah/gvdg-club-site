// The disc pick-lists behind the Marketplace and Lost & Found forms: brands, each brand's plastics, common molds,
// colours and weights, so a disc is entered the same way every time (one thumb, no typos) and matching compares
// like with like. Every list ends in "Other…" in the UI, so a disc that isn't listed can still be typed.
// parseSpokenDisc() turns a voice transcript ("orange Star Destroyer, 175 grams, hole 7") into those same values.
// Pure: node-tested in tests/disc-catalog.test.mjs.

export const DISC_BRANDS = [
  {
    name: "Innova", say: ["innova", "innova champion discs"],
    plastics: ["DX", "Pro", "KC Pro", "R-Pro", "XT", "Star", "GStar", "Halo Star", "Shimmer Star", "Champion", "Metal Flake Champion", "Blizzard Champion", "Nexus"],
    molds: ["Aviar", "Aviar3", "Pig", "Rhyno", "Wombat3", "Roc", "Roc3", "Mako3", "Leopard", "Leopard3", "Gator3", "Teebird", "Teebird3",
      "Thunderbird", "Firebird", "Destroyer", "Wraith", "Boss", "Shryke", "Valkyrie", "Eagle", "Sidewinder", "Tern", "Katana", "Corvette",
      "Daedalus", "Beast", "Mamba", "Starfire", "Orc", "Colossus", "Wahoo", "Invader", "Toro"],
  },
  {
    name: "Discraft", say: ["discraft", "disc craft"],
    plastics: ["Pro D", "Putter Line", "Jawbreaker", "X", "ESP", "Z", "Z Lite", "Z FLX", "ESP FLX", "Big Z", "Titanium", "CryZtal", "Rubber Blend"],
    molds: ["Luna", "Zone", "Zone OS", "Challenger", "Fierce", "Banger GT", "Magnet", "Kratos", "Buzzz", "Buzzz SS", "Comet", "Meteor",
      "Avenger SS", "Heat", "Undertaker", "Thrasher", "Nuke", "Nuke SS", "Zeus", "Force", "Predator", "Raptor", "Vulture", "Stalker",
      "Crank", "Hades", "Scorch", "Machete", "Anax", "Athena", "Drive", "Passion", "Mantis", "Sol", "Archer"],
  },
  {
    name: "Dynamic Discs", say: ["dynamic discs", "dynamic disc", "dynamic"],
    plastics: ["Prime", "Classic", "Classic Blend", "Classic Soft", "Fuzion", "BioFuzion", "Lucid", "Lucid Ice", "Lucid Air", "Fluid", "Supreme"],
    molds: ["Judge", "Warden", "Deputy", "Marshal", "Truth", "EMAC Truth", "Escape", "Trespass", "Felon", "Raider", "Sheriff", "Enforcer",
      "Maverick", "Getaway", "Defender", "Freedom", "Renegade", "Witness", "Vandal", "Evidence", "Suspect", "Convict", "Criminal", "Culprit"],
  },
  {
    name: "Latitude 64", say: ["latitude 64", "latitude sixty four", "latitude", "lat 64"],
    plastics: ["Retro", "Zero Hard", "Zero Medium", "Zero Soft", "Opto", "Opto Air", "Opto Ice", "Gold", "Grand", "Royal Grand", "Frost", "Moonshine"],
    molds: ["Pure", "Ruby", "Mercy", "Dagger", "Compass", "Fuse", "River", "Diamond", "Saint", "Saint Pro", "Explorer", "Grace", "Ballista",
      "Ballista Pro", "Bolt", "Raketen", "Missilen", "Musket", "Jade", "Sapphire", "Gladiator", "Recoil"],
  },
  {
    name: "Westside", say: ["westside", "west side", "westside discs"],
    plastics: ["BT Hard", "BT Medium", "BT Soft", "Origio", "VIP", "VIP Ice", "VIP Air", "Tournament", "Elasto"],
    molds: ["Harp", "Shield", "Warship", "Maiden", "Tursas", "Stag", "Hatchet", "Underworld", "Sword", "King", "Destiny", "Gatekeeper",
      "Queen", "Seer", "Boatman"],
  },
  {
    name: "Discmania", say: ["discmania", "disc mania"],
    plastics: ["D-Line", "P-Line", "S-Line", "C-Line", "Neo", "Exo", "Lux", "Geo", "Horizon", "Active", "Active Premium", "Vapor"],
    molds: ["P2", "MD3", "PD", "FD", "CD", "DD3", "Mutant", "Instinct", "Essence", "Origin", "Logic", "Method", "Rainmaker", "Splice", "Tactic"],
  },
  {
    name: "MVP", say: ["mvp", "m v p", "mvp disc sports"],
    plastics: ["Electron", "Electron Firm", "Electron Soft", "Neutron", "Proton", "Plasma", "Fission", "Eclipse", "Cosmic Neutron"],
    molds: ["Atom", "Ion", "Anode", "Glitch", "Entropy", "Servo", "Signal", "Volt", "Inertia", "Tesla", "Photon", "Wave", "Octane",
      "Teleport", "Tangent", "Vector", "Matrix", "Deflector", "Catalyst", "Dimension", "Reactor"],
  },
  {
    name: "Axiom", say: ["axiom", "axiom discs"],
    plastics: ["Electron", "Electron Firm", "Electron Soft", "Neutron", "Proton", "Plasma", "Fission", "Eclipse", "Cosmic Neutron"],
    molds: ["Envy", "Proxy", "Hex", "Crave", "Insanity", "Defy", "Tantrum", "Fireball", "Excite", "Mayhem", "Paradox", "Pyro", "Theory",
      "Vanish", "Wrath", "Delirium", "Inspire", "Panic", "Rhythm", "Time-Lapse"],
  },
  {
    name: "Streamline", say: ["streamline", "stream line"],
    plastics: ["Electron", "Neutron", "Proton", "Plasma", "Cosmic Neutron"],
    molds: ["Pilot", "Runway", "Drift", "Trace", "Lift", "Ascend"],
  },
  {
    name: "Kastaplast", say: ["kastaplast", "kasta plast", "casta plast", "castaplast"],
    plastics: ["K1", "K1 Soft", "K1 Glow", "K2", "K3"],
    molds: ["Berg", "Reko", "Kaxe", "Kaxe Z", "Grym", "Grym X", "Stal", "Lots", "Falk", "Svea", "Rask", "Gote"],
  },
  {
    name: "Prodigy", say: ["prodigy", "prodigy disc"],
    plastics: ["200 Series", "300 Series", "300 Soft", "350G", "400 Series", "400G", "500 Series", "750 Series", "Air"],
    molds: ["PA-3", "PA-4", "A3", "A4", "M4", "MX-3", "F3", "F5", "F7", "D1", "D2", "D3", "X3", "X5", "H3 V2", "H5"],
  },
  {
    name: "Gateway", say: ["gateway", "gateway disc sports"],
    plastics: ["Suregrip", "Organic", "Diamond", "Platinum", "Hyper Diamond"],
    molds: ["Wizard", "Warlock", "Voodoo", "Magic"],
  },
  {
    name: "Infinite Discs", say: ["infinite discs", "infinite"],
    plastics: ["I-Blend", "C-Blend", "S-Blend", "D-Blend", "G-Blend", "Metal Flake C-Blend"],
    molds: ["Emperor", "Pharaoh", "Sphinx", "Tomb", "Exodus"],
  },
  {
    name: "Thought Space Athletics", say: ["thought space athletics", "thought space", "tsa"],
    plastics: ["Aura", "Ethereal", "Nerve", "Glow"],
    molds: ["Votum", "Pathfinder", "Construct", "Mantra", "Synapse", "Muse"],
  },
  { name: "Mint Discs", say: ["mint discs"], plastics: ["Apex", "Sublime", "Eternal", "Nocturnal"], molds: ["Mustang", "Jackalope", "Freetail"] },
  {
    name: "Lone Star Discs", say: ["lone star discs", "lone star"],
    plastics: ["Alpha", "Bravo", "Charlie", "Delta 1", "Delta 2", "Victor 1", "Victor 2", "Lima", "Founders"], molds: [],
  },
  { name: "Clash Discs", say: ["clash discs", "clash"], plastics: ["Steady", "Softie", "Hardy"], molds: ["Popcorn", "Mango", "Berry", "Butter", "Cookie", "Pepper"] },
  { name: "Legacy", say: ["legacy discs", "legacy"], plastics: ["Pinnacle", "Excel", "Icon", "Protege", "Gravity"], molds: [] },
];

export const DISC_BRAND_NAMES = DISC_BRANDS.map((brand) => brand.name);

/** Colour names the Lost & Found matcher already groups (lf-vision COLOR_WORDS), so a picked colour always compares. */
export const DISC_COLOR_NAMES = ["Red", "Orange", "Yellow", "Lime", "Green", "Teal", "Blue", "Purple", "Pink", "White", "Black", "Gray", "Clear",
  "Glow", "Tie-dye", "Swirl", "Gold", "Silver", "Brown", "Tan"];

/** Heaviest first: most discs are 165–180 g, so those sit at the top of the phone's picker. */
export const DISC_WEIGHTS = Array.from({ length: 200 - 100 + 1 }, (_, index) => 200 - index);
export const COMMON_WEIGHT_RANGE = [120, 180];

export function brandEntry(name) {
  const key = choiceKey(name);
  return key ? DISC_BRANDS.find((brand) => choiceKey(brand.name) === key) || null : null;
}

/** The brand's plastics (or every listed plastic, deduplicated, when no brand is chosen). */
export function plasticsFor(brandName) {
  const brand = brandEntry(brandName);
  if (brand) return brand.plastics.slice();
  return [...new Set(DISC_BRANDS.flatMap((row) => row.plastics))].sort((a, b) => a.localeCompare(b));
}

export function moldsFor(brandName) {
  const brand = brandEntry(brandName);
  if (brand) return brand.molds.slice();
  return [...new Set(DISC_BRANDS.flatMap((row) => row.molds))].sort((a, b) => a.localeCompare(b));
}

/** "Halo star" -> "Halo Star" when it's a listed option, else the typed text as is. */
export function canonicalChoice(value, options) {
  const text = String(value ?? "").trim();
  const key = choiceKey(text);
  return (key && options.find((option) => choiceKey(option) === key)) || text;
}

export function choiceKey(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function colorName(value) {
  const key = choiceKey(value);
  if (!key) return "";
  if (key === "grey") return "Gray";
  if (key === "tiedye") return "Tie-dye";
  return DISC_COLOR_NAMES.find((name) => choiceKey(name) === key) || "";
}

// ---- Voice ----

const NUMBER_WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
// Whisper's usual spellings of molds and plastics with digits or odd letters.
const SPOKEN_ALIASES = {
  Buzzz: ["buzz", "buzzz"], "Buzzz SS": ["buzz ss", "buzz s s"], Teebird: ["tee bird", "tea bird", "t bird"], Teebird3: ["tee bird 3", "teebird 3", "tee bird three"],
  Mako3: ["mako 3", "mako three"], Roc3: ["roc 3", "rock 3", "rock three", "roc three"], Roc: ["rock"], Aviar3: ["aviar 3", "aviar three"],
  Leopard3: ["leopard 3", "leopard three"], Wombat3: ["wombat 3", "wombat three"], Gator3: ["gator 3", "gator three"],
  MD3: ["md 3", "m d 3", "md three"], DD3: ["dd 3", "d d 3", "dd three"], P2: ["p 2", "p two"], PD: ["p d"], FD: ["f d"], CD: ["c d"],
  "PA-3": ["pa 3", "p a 3", "pa three"], "PA-4": ["pa 4", "p a 4"], "MX-3": ["mx 3", "m x 3"], "Banger GT": ["banger g t", "banger"],
  "EMAC Truth": ["emac truth", "e mac truth"], "Time-Lapse": ["time lapse", "timelapse"], "Zone OS": ["zone o s"], "Nuke SS": ["nuke s s"],
  "Avenger SS": ["avenger", "avenger s s"], GStar: ["g star", "gstar"], "R-Pro": ["r pro"], "KC Pro": ["k c pro", "kc pro"], DX: ["d x"],
  XT: ["x t"], ESP: ["e s p", "esp"], "Big Z": ["big z", "big zee"], "Z Lite": ["z light", "zee light", "z lite"], "Z FLX": ["z flex", "zee flex"],
  "ESP FLX": ["esp flex", "e s p flex"], "Pro D": ["pro d", "pro dee"], Champion: ["champion", "champ"], "Halo Star": ["halo star", "halo"],
  "Metal Flake Champion": ["metal flake champion", "metal flake"], "Blizzard Champion": ["blizzard champion", "blizzard"],
  Z: ["z", "zee", "z line"], "BT Medium": ["bt medium", "b t medium"], "BT Hard": ["bt hard", "b t hard"], "BT Soft": ["bt soft", "b t soft"],
  VIP: ["vip", "v i p"], "VIP Ice": ["vip ice", "v i p ice"], K1: ["k1", "k 1", "k one"], K2: ["k2", "k 2", "k two"], K3: ["k3", "k 3", "k three"],
  "K1 Soft": ["k1 soft", "k 1 soft"], "D-Line": ["d line"], "P-Line": ["p line"], "S-Line": ["s line"], "C-Line": ["c line"],
  "400G": ["400 g", "four hundred g"], "350G": ["350 g"], "I-Blend": ["i blend"], "C-Blend": ["c blend"], "S-Blend": ["s blend"],
  "Opto Air": ["opto air"], "Zero Medium": ["zero medium"], "Lucid Ice": ["lucid ice"],
};

function spoken(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "one seventy five" / "one hundred seventy five" / "175" -> 175; "seven" -> 7. Digits pass through. */
export function spokenNumbersToDigits(text) {
  const words = spoken(text).split(" ").filter(Boolean);
  const out = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!(word in NUMBER_WORDS)) { out.push(word); continue; }
    let value = 0;
    let used = 0;
    const take = () => NUMBER_WORDS[words[index + used]];
    // "one seventy five" / "one hundred (and) seventy five"
    if (NUMBER_WORDS[word] === 1 && (words[index + 1] === "hundred" || (NUMBER_WORDS[words[index + 1]] >= 20 && NUMBER_WORDS[words[index + 1]] < 100))) {
      value = 100;
      used = words[index + 1] === "hundred" ? 2 : 1;
      if (words[index + used] === "and") used += 1;
    }
    if (words[index + used] in NUMBER_WORDS && take() < 100) {
      const first = take();
      value += first;
      used += 1;
      if (first >= 20 && first % 10 === 0 && words[index + used] in NUMBER_WORDS && take() > 0 && take() < 10) {
        value += take();
        used += 1;
      }
    }
    if (!used) { out.push(String(NUMBER_WORDS[word])); continue; }
    out.push(String(value));
    index += used - 1;
  }
  return out.join(" ");
}

// Everyday words that are also mold or plastic names ("off the drive", "pure luck", "the gold one"): only taken
// when the brand was said, so a story about the round doesn't fill the form.
const NEEDS_BRAND = new Set(["Drive", "Pure", "Magic", "Escape", "Freedom", "Evidence", "Lift", "Trace", "Signal", "King", "Queen", "Passion",
  "Origin", "Logic", "Method", "Theory", "Panic", "Grace", "Mercy", "River", "Diamond", "Link", "Force", "Wave", "Comet", "Heat", "Envy",
  "Air", "Glow", "Gold", "Pro", "Classic", "Prime", "Steady", "Founders", "Alpha", "Bravo", "Charlie", "Organic", "Icon", "Excel", "Gravity",
  "Active", "Retro", "Frost", "Supreme", "Fluid", "X", "Destiny", "Archer", "Sol", "Muse", "Rhythm", "Inspire", "Excite", "Defy", "Boss", "Beast"]);

function phrasesFor(name, extra = []) {
  return [...new Set([spoken(name), ...(SPOKEN_ALIASES[name] || []).map(spoken), ...extra.map(spoken)].filter(Boolean))];
}

function findPhrase(text, phrases) {
  // Whole words only, longest phrase first: "buzz ss" beats "buzz", "z lite" beats "z".
  let best = null;
  for (const phrase of phrases) {
    const match = new RegExp("(?:^| )" + phrase.replace(/ /g, " ") + "(?= |$)").exec(text);
    if (match && (!best || phrase.length > best.phrase.length)) best = { phrase, index: match.index };
  }
  return best;
}

function pickFrom(text, names) {
  let best = null;
  for (const name of names) {
    const hit = findPhrase(text, phrasesFor(name));
    if (hit && (!best || hit.phrase.length > best.hit.phrase.length)) best = { name, hit };
  }
  return best;
}

// ---- Where exactly ----

const SPOT_START = /\b(?:in|by|near|under|behind|beside|next to|left of|right of|past|across|along|inside|around|off|over|below|at the (?:bottom|top|edge|back|base) of|on the (?:left|right|edge|side))\b/i;
const SPOT_NOUN = /\b(?:pond|lake|creek|stream|river|water|swamp|marsh|woods|wood|forest|trees?|bush(?:es)?|brush|shrubs?|thicket|rough|fairway|basket|pin|tee|pad|parking|lot|bench|trail|path|road|fence|hill|ditch|grass|field|shed|bin|sign|bridge|rocks?|gravel|sidewalk|drop zone|mando|out of bounds|ob|green|circle|ravine|gully|pine|leaves|mud|sand|playground|pavilion|bathroom|restroom|dumpster|cart path|tree line|treeline|bank|shore|island)\b/i;
const SPOT_END = /\s+(?:on hole\b|hole\b|at\s+(?!the\b)|it'?s\s|it was\s|weighs\b|\d{3}\s*(?:g|grams)\b).*$/i;

/** The place a disc was, said in passing: "…in the pond left of the fairway" -> "In the pond left of the fairway". */
export function parseSpokenSpot(transcript, maxLength = 48) {
  const clauses = String(transcript ?? "").split(/[.,;!?]+|\s+and then\s+|\s+(?:and|but)\s+(?=(?:it was|found|lost)\b)/i).map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses.reverse()) {
    const start = SPOT_START.exec(clause);
    if (!start) continue;
    let spot = clause.slice(start.index).replace(SPOT_END, "").trim();
    if (!SPOT_NOUN.test(spot) || /^(?:in|on|at)\s+hole\b/i.test(spot)) continue;
    spot = spot.replace(/\s+/g, " ");
    if (spot.length > maxLength) spot = spot.slice(0, maxLength).replace(/\s+\S*$/, "");
    return spot.charAt(0).toUpperCase() + spot.slice(1);
  }
  return "";
}

/**
 * A voice transcript -> the form's values. Only what was heard is returned (missing keys mean "not said").
 * `holes`: how many holes the chosen course has, so "hole 7" is kept only when it exists.
 */
export function parseSpokenDisc(transcript, { holes = 27 } = {}) {
  const text = spokenNumbersToDigits(transcript);
  const fields = {};
  if (!text) return fields;

  // Brand: said outright, else from a mold only one brand makes.
  let brand = null;
  let best = null;
  for (const row of DISC_BRANDS) {
    const hit = findPhrase(text, [...new Set([spoken(row.name), ...row.say.map(spoken)])]);
    if (hit && (!best || hit.phrase.length > best.hit.phrase.length)) best = { row, hit };
  }
  if (best) brand = best.row;

  const moldPool = brand ? brand.molds : DISC_BRANDS.flatMap((row) => row.molds).filter((name) => !NEEDS_BRAND.has(name));
  const mold = pickFrom(text, [...new Set(moldPool)]);
  if (mold) {
    fields.mold = mold.name;
    if (!brand) {
      const makers = DISC_BRANDS.filter((row) => row.molds.includes(mold.name));
      if (makers.length === 1) brand = makers[0];
    }
  }

  const plasticPool = brand ? brand.plastics : [...new Set(DISC_BRANDS.flatMap((row) => row.plastics))].filter((name) => !NEEDS_BRAND.has(name));
  // A lone "z" is only Discraft's Z when the brand says so (it's too easy to hear by accident).
  const plastic = pickFrom(text, plasticPool.filter((name) => name !== "Z" || brand?.name === "Discraft"));
  if (plastic && !(mold && plastic.hit.phrase === mold.hit.phrase)) {
    fields.plastic = plastic.name;
    if (!brand) {
      const makers = DISC_BRANDS.filter((row) => row.plastics.includes(plastic.name));
      if (makers.length === 1) brand = makers[0];
    }
  }
  if (brand) fields.brand = brand.name;

  // Colour: a colour word that isn't part of the plastic's name ("Gold" plastic vs a gold disc).
  const plasticWords = new Set(fields.plastic ? spoken(fields.plastic).split(" ") : []);
  for (const word of text.replace(/\btie dye\b/g, "tiedye").split(" ")) {
    const color = colorName(word);
    if (color && !plasticWords.has(word)) { fields.color = color; break; }
  }

  // Hole: "hole 7", "hole number 7".
  const hole = /(?:^| )hole (?:number )?(\d{1,2})(?= |$)/.exec(text);
  if (hole && Number(hole[1]) >= 1 && Number(hole[1]) <= holes) fields.hole = Number(hole[1]);

  // Weight: "175 grams", "175 g", or a lone 3-digit number in the disc range that isn't a hole.
  const grams = /(?:^| )(\d{3})(?: ?(?:g|gram|grams|gs))(?= |$)/.exec(text) || /(?:^| )(1[0-9]{2}|200)(?= |$)/.exec(text);
  if (grams && Number(grams[1]) >= 100 && Number(grams[1]) <= 200) fields.weightG = Number(grams[1]);
  const spot = parseSpokenSpot(transcript);
  if (spot) fields.area = spot;
  return fields;
}
