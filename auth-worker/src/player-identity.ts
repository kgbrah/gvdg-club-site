// Keep in sync with src/shared/player-identity.js — the worker cannot import that module.

const GIVEN_ALIASES: Record<string, string> = {
  jeff: "jeffrey",
  jeffrey: "jeffrey",
  jon: "jonathan",
  jonathan: "jonathan",
  mike: "michael",
  michael: "michael",
  pj: "pj",
  tj: "tj",
};

function nameWithoutQuotes(name: string | null | undefined): string {
  return String(name || "").replace(/"[^"]*"/g, " ");
}

export function compactPlayerName(name: string | null | undefined): string {
  return nameWithoutQuotes(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function playerNameTokens(name: string | null | undefined): string[] {
  return nameWithoutQuotes(name)
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function quotedNicknames(name: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(name))) {
    for (const token of String(match[1] || "")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 1)) {
      out.push(token);
    }
  }
  return out;
}

function lastToken(tokens: readonly string[]): string {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] && tokens[i]!.length > 1) return tokens[i]!;
  }
  return tokens[tokens.length - 1] || "";
}

function givenAlias(token: string): string {
  return GIVEN_ALIASES[token] || token;
}

export function preferredPlayerName(names: readonly string[]): string {
  return [...names].filter((name) => String(name || "").trim()).sort((left, right) => {
    const leftTokens = playerNameTokens(left).length;
    const rightTokens = playerNameTokens(right).length;
    if (rightTokens !== leftTokens) return rightTokens - leftTokens;
    return String(right).length - String(left).length;
  })[0] || "";
}

export function playersMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (compactPlayerName(a) === compactPlayerName(b)) return true;

  const tokensA = playerNameTokens(a);
  const tokensB = playerNameTokens(b);
  if (!tokensA.length || !tokensB.length) return false;

  const nicksA = quotedNicknames(a);
  const nicksB = quotedNicknames(b);
  if (tokensA.length === 1 && nicksB.includes(tokensA[0]!)) return true;
  if (tokensB.length === 1 && nicksA.includes(tokensB[0]!)) return true;

  const lastA = lastToken(tokensA);
  const lastB = lastToken(tokensB);
  if (tokensA.length === 1 && lastA.length > 2 && lastA === lastB) return true;
  if (tokensB.length === 1 && lastB.length > 2 && lastA === lastB) return true;

  if (givenAlias(tokensA[0]!) !== givenAlias(tokensB[0]!)) return false;
  if (lastA && lastA === lastB) return true;
  if (tokensA.length >= 2 && tokensB.length >= 2) {
    const initA = tokensA[tokensA.length - 1]!;
    const initB = tokensB[tokensB.length - 1]!;
    if (initA.length === 1 && lastB.startsWith(initA)) return true;
    if (initB.length === 1 && lastA.startsWith(initB)) return true;
  }
  return false;
}

export function clusterPlayerNames(names: readonly (string | null | undefined)[]): Map<string, string> {
  const labels: string[] = [];
  for (const name of names) {
    const label = String(name || "").trim();
    if (label) labels.push(label);
  }
  const parent = new Map<string, string>();

  function find(name: string): string {
    if (!parent.has(name)) parent.set(name, name);
    let current = name;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)!)!);
      current = parent.get(current)!;
    }
    return current;
  }

  function union(left: string, right: string): void {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft === rootRight) return;
    const keep = preferredPlayerName([rootLeft, rootRight]);
    parent.set(keep === rootLeft ? rootRight : rootLeft, keep);
  }

  const byCompact = new Map<string, string>();
  for (const name of labels) {
    find(name);
    const compact = compactPlayerName(name);
    if (!compact) continue;
    const existing = byCompact.get(compact);
    if (existing) union(name, existing);
    else byCompact.set(compact, name);
  }

  const unique = [...new Set(labels)];
  const shorterFirst = [...unique].sort((left, right) => {
    const tokenDelta = playerNameTokens(left).length - playerNameTokens(right).length;
    return tokenDelta || String(left).length - String(right).length;
  });
  for (const name of shorterFirst) {
    const roots = [...new Set(unique.map(find))];
    const candidates = roots.filter((other) => other !== find(name) && playersMatch(name, other));
    if (candidates.length !== 1) continue;
    const other = candidates[0]!;
    const nameLen = playerNameTokens(name).length;
    const otherLen = playerNameTokens(other).length;
    if (nameLen > otherLen) continue;
    if (nameLen === otherLen && String(name).length >= String(other).length) continue;
    union(name, other);
  }

  const clustered = new Map<string, string>();
  for (const name of labels) clustered.set(name, find(name));
  return clustered;
}

export function resolvePlayerName(name: string | null | undefined, roster: readonly string[] = []): string {
  const label = String(name || "").trim();
  if (!label) return "";
  const clustered = clusterPlayerNames([label, ...roster]);
  const canonical = clustered.get(label) || label;
  const rosterHit = roster.find((row) => clustered.get(String(row || "").trim()) === canonical);
  return rosterHit || canonical;
}
