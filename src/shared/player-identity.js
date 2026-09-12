// Keep in sync with auth-worker/src/player-identity.ts — the worker cannot import this module.

const GIVEN_ALIASES = {
  jeff: "jeffrey",
  jeffrey: "jeffrey",
  jon: "jonathan",
  jonathan: "jonathan",
  mike: "michael",
  michael: "michael",
  pj: "pj",
  tj: "tj",
};

// Club nicknames that cannot be inferred from the legal name.
const KNOWN_NICKNAMES = {
  jackie: "jarrett wallace",
};

function nameWithoutQuotes(name) {
  return String(name || "").replace(/"[^"]*"/g, " ");
}

export function compactPlayerName(name) {
  return nameWithoutQuotes(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function playerNameTokens(name) {
  return nameWithoutQuotes(name)
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function quotedNicknames(name) {
  const out = [];
  const re = /"([^"]+)"/g;
  const source = String(name || "");
  let match;
  while ((match = re.exec(source))) {
    for (const token of String(match[1] || "")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 1)) {
      out.push(token);
    }
  }
  return out;
}

function lastToken(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] && tokens[i].length > 1) return tokens[i];
  }
  return tokens[tokens.length - 1] || "";
}

function givenAlias(token) {
  return GIVEN_ALIASES[token] || token;
}

function expandKnownNickname(name) {
  const compact = compactPlayerName(name);
  const fromCompact = KNOWN_NICKNAMES[compact];
  if (fromCompact) return fromCompact;
  const tokens = playerNameTokens(name);
  const fromToken = tokens.length === 1 ? KNOWN_NICKNAMES[tokens[0]] : "";
  return fromToken || name;
}

export function preferredPlayerName(names) {
  return [...names].filter((name) => String(name || "").trim()).sort((left, right) => {
    const leftTokens = playerNameTokens(left).length;
    const rightTokens = playerNameTokens(right).length;
    if (rightTokens !== leftTokens) return rightTokens - leftTokens;
    return String(right).length - String(left).length;
  })[0] || "";
}

export function playersMatch(left, right) {
  const a = expandKnownNickname(String(left || "").trim());
  const b = expandKnownNickname(String(right || "").trim());
  if (!a || !b) return false;
  if (compactPlayerName(a) === compactPlayerName(b)) return true;

  const tokensA = playerNameTokens(a);
  const tokensB = playerNameTokens(b);
  if (!tokensA.length || !tokensB.length) return false;

  const nicksA = quotedNicknames(a);
  const nicksB = quotedNicknames(b);
  if (tokensA.length === 1 && nicksB.includes(tokensA[0])) return true;
  if (tokensB.length === 1 && nicksA.includes(tokensB[0])) return true;

  const lastA = lastToken(tokensA);
  const lastB = lastToken(tokensB);
  if (tokensA.length === 1 && lastA.length > 2 && lastA === lastB) return true;
  if (tokensB.length === 1 && lastB.length > 2 && lastA === lastB) return true;

  if (tokensA.length === 1 && tokensB.length >= 2 && tokensA[0].length > 1 && tokensA[0] === tokensB[0]) return true;
  if (tokensB.length === 1 && tokensA.length >= 2 && tokensB[0].length > 1 && tokensA[0] === tokensB[0]) return true;

  if (givenAlias(tokensA[0]) !== givenAlias(tokensB[0])) return false;
  if (lastA && lastA === lastB) return true;
  if (tokensA.length >= 2 && tokensB.length >= 2) {
    const initA = tokensA[tokensA.length - 1];
    const initB = tokensB[tokensB.length - 1];
    if (initA.length === 1 && lastB.startsWith(initA)) return true;
    if (initB.length === 1 && lastA.startsWith(initB)) return true;
  }
  return false;
}

export function clusterPlayerNames(names) {
  const labels = [];
  for (const name of names || []) {
    const label = String(name || "").trim();
    if (label) labels.push(label);
  }
  const parent = new Map();

  function find(name) {
    if (!parent.has(name)) parent.set(name, name);
    let current = name;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  }

  function union(left, right) {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft === rootRight) return;
    const keep = preferredPlayerName([rootLeft, rootRight]);
    parent.set(keep === rootLeft ? rootRight : rootLeft, keep);
  }

  const byCompact = new Map();
  for (const name of labels) {
    find(name);
    const compact = compactPlayerName(expandKnownNickname(name));
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
    const other = candidates[0];
    const nameLen = playerNameTokens(name).length;
    const otherLen = playerNameTokens(other).length;
    if (nameLen > otherLen) continue;
    if (nameLen === otherLen && String(name).length >= String(other).length) continue;
    union(name, other);
  }

  const clustered = new Map();
  for (const name of labels) clustered.set(name, find(name));
  return clustered;
}

export function resolvePlayerName(name, roster) {
  const label = String(name || "").trim();
  if (!label) return "";
  const names = [label, ...(Array.isArray(roster) ? roster : [])];
  const clustered = clusterPlayerNames(names);
  const canonical = clustered.get(label) || label;
  const rosterHit = (Array.isArray(roster) ? roster : []).find((row) => clustered.get(String(row || "").trim()) === canonical);
  return rosterHit || canonical;
}
