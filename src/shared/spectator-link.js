export function watchKeyFromLocation(loc) {
  const search = new URLSearchParams(loc.search);
  const fragment = new URLSearchParams(String(loc.hash || "").replace(/^#/, ""));
  const key = fragment.get("wl") ?? search.get("wl");
  return /^[a-f0-9]{48}$/.test(key ?? "") ? key : null;
}

export function watchUrl(path, loc, key) {
  const url = new URL(path, loc.href);
  if (key) url.hash = "wl=" + key;
  return url.href;
}

export function spectatorHeaders(key) {
  return key ? { Authorization: "Watch " + key } : {};
}

export function spectatorSocketProtocols(key, token) {
  return ["gvdg-watch-v1", ...(key ? ["w." + key] : token ? ["a." + token] : [])];
}

export function scorerSocketProtocols({ type, token }) {
  return ["gvdg-score-v1", (type === "guest" ? "g." : "a.") + token];
}
