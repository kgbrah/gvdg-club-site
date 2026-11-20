import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "https://auth.gvdgclub.com";
const QA_PDGA_CANDIDATES = ["90000001", "90000002", "90000003"];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

function env(name) {
  return (process.env[name] || "").trim();
}

function loadDeployEnv() {
  const file = path.join(repoRoot, ".gvdg-deploy.env");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function cleanUrl(value, fallback) {
  return (value || fallback).replace(/\/+$/, "");
}

function headers(token) {
  const out = { Accept: "application/json" };
  if (token) out.Authorization = "Bearer " + token;
  return out;
}

async function requestJson(apiBase, pathName, options = {}) {
  const requestHeaders = headers(options.token);
  const init = {
    method: options.method || "GET",
    headers: requestHeaders,
    signal: AbortSignal.timeout(options.timeoutMs || 20_000),
  };
  if (options.body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(apiBase + pathName, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const err = new Error(data?.error || text || `HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function qaToken(apiBase) {
  const token = env("GVDG_STAGING_QA_TOKEN");
  if (token) return token;
  const identifier = env("GVDG_STAGING_QA_IDENTIFIER");
  const pin = env("GVDG_STAGING_QA_PIN");
  if (!identifier || !pin) {
    throw new Error("Set GVDG_STAGING_QA_TOKEN, or GVDG_STAGING_QA_IDENTIFIER plus GVDG_STAGING_QA_PIN.");
  }
  const data = await requestJson(apiBase, "/login", { method: "POST", body: { identifier, pin } });
  if (!data?.token) throw new Error("Login succeeded without a token.");
  return data.token;
}

async function setQaPdga(apiBase, token, preferred) {
  const candidates = preferred ? [preferred] : QA_PDGA_CANDIDATES;
  for (const pdga of candidates) {
    try {
      await requestJson(apiBase, "/profile", { method: "POST", token, body: { pdgaNo: pdga } });
      return pdga;
    } catch (error) {
      if (error?.status !== 409) throw error;
    }
  }
  throw new Error("Every QA PDGA candidate is already linked to another member.");
}

// /pdga-stats comes only from PDGA's official API (PDGA's terms: no stored PDGA data to seed). The QA numbers are not
// real PDGA numbers; the Worker answers its QA number (90000001) with a fixed official rating so the dashboard has one.
async function officialRating(apiBase, pdga) {
  try {
    const stats = await requestJson(apiBase, `/pdga-stats?pdga=${encodeURIComponent(pdga)}`);
    return stats?.official_rating ?? null;
  } catch {
    return null;
  }
}

async function main() {
  loadDeployEnv();
  const apiBase = cleanUrl(env("GVDG_STAGING_API_URL"), DEFAULT_API_URL);
  const token = await qaToken(apiBase);
  const member = await requestJson(apiBase, "/me", { token });
  const preferred = env("GVDG_STAGING_QA_PDGA");
  let pdga = "";
  if (preferred) pdga = await setQaPdga(apiBase, token, preferred);
  else if (member?.pdgaNo && QA_PDGA_CANDIDATES.includes(member.pdgaNo)) pdga = member.pdgaNo;
  else pdga = await setQaPdga(apiBase, token);
  const rating = await officialRating(apiBase, pdga);
  console.log(rating == null
    ? `staging dashboard QA data ready (PDGA #${pdga}: no official rating; Home shows —)`
    : `staging dashboard QA data ready (PDGA #${pdga}: official rating ${rating})`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
