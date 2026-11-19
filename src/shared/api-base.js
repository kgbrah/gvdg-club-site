const LOCAL_API_BASE = "http://127.0.0.1:8788";
const DEV_API_BASE = "https://auth.gvdgclub.com";
const PRODUCTION_API_BASE = "https://auth.greenvillediscgolf.com";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const PRODUCTION_HOSTS = new Set(["greenvillediscgolf.com", "www.greenvillediscgolf.com"]);
// The club site serves its API at /api on its own address (a Cloudflare Worker route for gvdgclub.com/api/*): no CORS
// preflight before each call and no second connection to another host.
const SAME_ORIGIN_HOSTS = new Set(["gvdgclub.com", "www.gvdgclub.com"]);

function normalizedBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function configuredBase(dataset, keys) {
  const source = dataset || {};
  for (const key of keys) {
    const value = normalizedBase(source[key]);
    if (value) return value;
  }
  return "";
}

export function resolveApiBase({
  dataset = globalThis.document?.body?.dataset,
  datasetKeys = ["apiBase", "authBase"],
  hostname = globalThis.location?.hostname,
} = {}) {
  const configured = configuredBase(dataset, datasetKeys);
  if (configured) return configured;

  const host = String(hostname || "");
  if (LOCAL_HOSTS.has(host)) return LOCAL_API_BASE;
  if (PRODUCTION_HOSTS.has(host)) return PRODUCTION_API_BASE;
  if (SAME_ORIGIN_HOSTS.has(host)) return `https://${host}/api`;
  return DEV_API_BASE;
}
