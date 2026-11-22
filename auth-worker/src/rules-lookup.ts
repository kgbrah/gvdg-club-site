// Club-helper notes for rules questions. Original wording, not the PDGA rulebook.
// Section links point at the public 2026 rules. The card or TD still makes the call.

export interface RuleNote {
  id: string;
  title: string;
  href: string;
  keywords: readonly string[];
  note: string;
}

export const PDGA_RULES_HOME = "https://www.pdga.com/rules/official-rules-disc-golf";

const RULES_BASE = "https://www.pdga.com/rules/official-rules-disc-golf";

export const RULE_NOTES: readonly RuleNote[] = [
  {
    id: "ob",
    title: "Out of bounds",
    href: RULES_BASE + "/80602",
    keywords: ["ob", "o.b", "out of bounds", "out-of-bounds", "water", "pond", "creek", "lake", "rope", "painted", "paint", "fence"],
    note: "Judge the disc where it came to rest: it is out of bounds only if it is clearly and completely surrounded by OB (benefit of the doubt goes to the player). An OB lie costs one penalty throw and the next throw is taken from up to 1 meter perpendicular from where the disc last crossed in-bounds, from the previous lie, or from a marked drop zone (optional relief back along the line of play is also available). A photo can show a disc next to a line, not a boundary outside the frame or tee-sign notes.",
  },
  {
    id: "hazard",
    title: "Hazard",
    href: RULES_BASE + "/80605",
    keywords: ["hazard", "bunker", "sand trap"],
    note: "A hazard is a TD-designated area that adds one penalty throw, but unlike out of bounds, it does not change your lie: you play your next throw from where the disc lies inside the hazard (unless you take optional relief back along the line of play for an additional penalty).",
  },
  {
    id: "lost",
    title: "Lost disc",
    href: RULES_BASE + "/80503",
    keywords: ["lost", "can't find", "cannot find", "cant find", "missing disc", "search"],
    note: "Once players reach the area where the disc is likely to be, the group searches for 3 minutes. If the disc is not found within 3 minutes, it is declared lost: add one penalty throw and play the next shot from the previous lie or a marked drop zone. Wait until the 3-minute search ends (voluntarily giving up earlier is an abandoned throw under 809.01, also one penalty from the previous lie).",
  },
  {
    id: "mando",
    title: "Mandatory",
    href: RULES_BASE + "/80401",
    keywords: ["mando", "mandatory", "double mando"],
    note: "A mandatory creates a restricted plane extending from the mandatory object. The disc misses the mandatory when it clearly enters that restricted plane from the front/tee side, costing one penalty throw with play continuing from the marked drop zone or the previous lie. An arrow in a photo is a clue, but the card must judge whether the disc actually crossed the restricted plane.",
  },
  {
    id: "mark",
    title: "Marking the lie",
    href: RULES_BASE + "/80206",
    keywords: ["mark", "mini", "marker", "lie", "where it landed"],
    note: "The thrown disc itself serves as the marker until you place a mini marker disc on the playing surface touching the front edge of the thrown disc on the line of play and lift it.",
  },
  {
    id: "stance",
    title: "Stance and putting",
    href: RULES_BASE + "/80601",
    keywords: ["foot fault", "footfault", "putting", "putt", "circle", "stance", "step", "jump putt"],
    note: "Any throw from within 10 meters of the target (measured from the front of the lie to the base of the target) is a putt: after releasing, you must demonstrate full control of balance behind your lie before advancing closer to the target. Outside 10 meters, you may follow through past the lie after release. A still frame cannot prove motion or balance by itself.",
  },
  {
    id: "relief",
    title: "Relief",
    href: RULES_BASE + "/80302",
    keywords: ["relief", "casual", "tree", "stuck", "dangerous", "puddle", "two meter", "two-meter", "2 meter", "2-meter"],
    note: "Free relief from casual areas (Rule 806.03) or harmful insects and animals (Rule 803.02.B) moves the lie straight back along the line of play to the nearest non-closer spot (not sideways). Solid obstacles behind the lie allow relocation only when they prevent a legal stance. Optional relief (803.03) and abandoned throws (809.01) cost one penalty throw. A disc stuck in a tree marks directly beneath it (805.01.C); the two-meter rule (805.02, one penalty throw above 2m) is off by default and applies only when explicitly declared by the TD.",
  },
  {
    id: "order",
    title: "Who throws next",
    href: RULES_BASE + "/80202",
    keywords: ["away", "order", "honors", "who throws", "tee order"],
    note: "Tee order follows the scorecard on Hole 1 and lowest-to-highest previous-hole scores after that. Once everyone has teed off, the player farthest from the basket throws next. Throwing out of order is a courtesy matter (or allowed when ready golf is agreed by the group).",
  },
  {
    id: "provisional",
    title: "Provisional",
    href: RULES_BASE + "/80902",
    keywords: ["provisional", "second throw", "not sure"],
    note: "Declare a provisional throw to the group before throwing it. When a ruling or lie is contested and cannot wait for an official, play out the hole from both lies, record both scores, and bring the facts to the Tournament Director after the round to decide which score stands.",
  },
  {
    id: "misplay",
    title: "Misplay",
    href: RULES_BASE + "/811",
    keywords: ["misplay", "wrong basket", "wrong hole", "wrong target", "wrong lie"],
    note: "Playing from the wrong lie, wrong tee, wrong target, or failing to play from the drop zone after missing a mandatory is a misplay. Stop as soon as noticed and apply Rule 811 remedies (typically two penalty throws if the hole was completed uncorrected, or replaying before teeing off on the next hole); confirm the exact correction with the TD.",
  },
  {
    id: "practice",
    title: "Practice throws",
    href: RULES_BASE + "/80903",
    keywords: ["practice throw", "extra throw", "warm up", "warmup"],
    note: "Under Rule 809.03, any non-competitive throw of 2 meters or more during a round (outside permitted exceptions such as a casual warm-up before play starts) is disregarded and adds an immediate 1-throw penalty to your score.",
  },
  {
    id: "scoring",
    title: "Scoring & scorecards",
    href: RULES_BASE + "/808",
    keywords: ["scoring", "scorecard", "keep score", "scorekeeper", "turn in", "submit", "wrong score", "late card", "808", "par+4", "par + 4", "dnf"],
    note: "Under Rule 808 (current PDGA rules), every player in the group must keep an independent scorecard for the entire group (paper or PDGA digital; refusing to keep score is disqualification). Verify your own total and turn in or finalize the scorecard within 30 minutes after your group finishes (incorrect totals or late submission carry two penalty throws). Missed holes due to late arrival are scored par + 4.",
  },
  {
    id: "complete",
    title: "Holing out",
    href: RULES_BASE + "/807",
    keywords: ["in the basket", "holed", "spit out", "spitout", "hanging", "chains", "complete", "ace"],
    note: "To hole out, the disc must enter the target above the top edge of the tray and below the bottom of the chain support, and come to rest supported by the tray or the chains below the chain support. A disc resting on top of the basket or bouncing back out does not complete the hole.",
  },
];

const IMAGE_CORE = ["ob", "mark", "mando", "relief"] as const;

function haystack(message: string): string {
  return message.toLowerCase().replace(/[^a-z0-9.]+/g, " ");
}

function matches(note: RuleNote, text: string): boolean {
  return note.keywords.some((word) => text.includes(word));
}

/** Notes to inject. Empty when the message is not a rules question and there is no photo. */
export function rulesForQuestion(message: string, hasImage: boolean): RuleNote[] {
  const text = haystack(message);
  const picked: RuleNote[] = [];
  const seen = new Set<string>();
  const add = (note: RuleNote | undefined) => {
    if (!note || seen.has(note.id) || picked.length >= 5) return;
    seen.add(note.id);
    picked.push(note);
  };
  for (const note of RULE_NOTES) {
    if (matches(note, text)) add(note);
  }
  if (hasImage) {
    for (const id of IMAGE_CORE) add(RULE_NOTES.find((note) => note.id === id));
  }
  return picked;
}

export function formatRulesContext(notes: readonly RuleNote[]): string {
  if (!notes.length) return "";
  const lines = [
    "Rules helper notes (use these for a rules question; they outrank general knowledge):",
    "This is a club helper, not a tournament director and not the official rulebook. Tell the player the card agrees the facts, and the TD decides if the card cannot. Do not quote the rulebook at length. Name the section and give the link.",
    "Official rules: " + PDGA_RULES_HOME,
  ];
  for (const note of notes) {
    lines.push("- " + note.title + " (" + note.href + "): " + note.note);
  }
  return lines.join("\n");
}

export function formatPhotoContext(descriptions: readonly string[], mediaKind: string): string {
  const clean = descriptions.map((line) => line.trim()).filter(Boolean).slice(0, 3);
  const lines = ["Attached media for a rules question:"];
  if (mediaKind === "video") {
    lines.push("The player sent a short video. You are looking at still frames from it, not the motion. Say that you cannot judge a foot fault, a spit-out, or the flight from a still.");
  } else if (clean.length) {
    lines.push("The player sent a photo. Describe only what the notes below say is visible.");
  }
  if (!clean.length) {
    lines.push("The attachment could not be read. Ask them to describe the lie, the line, and where the disc stopped.");
    return lines.join("\n");
  }
  lines.push("What is visible (a description, not a ruling):");
  clean.forEach((line, index) => lines.push(String(index + 1) + ". " + line.slice(0, 700)));
  return lines.join("\n");
}
