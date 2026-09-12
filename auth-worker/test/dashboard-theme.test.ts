import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { putMember } from "../src/roster.js";
import { hashPin } from "../src/crypto.js";
import type { KVLike } from "../src/ratelimit.js";
import type { Env } from "../src/index.js";

const ORIGIN = "https://www.greenvillediscgolf.com";
const PIN = "4821";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=";

function makeKV(): KVLike {
  const store = new Map<string, string>();
  return {
    get: async (key) => (store.has(key) ? store.get(key)! : null),
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
}

function makeDB() {
  const stmt = { bind: () => stmt, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => ({ results: [], success: true }) };
  return { prepare: () => stmt };
}

const TOKENS = {
  primary: "#ff6b35",
  "primary-strong": "#c8410f",
  secondary: "#004e89",
  accent: "#f7b801",
  green: "#2d5016",
  "bg-primary": "#101018",
  "bg-secondary": "#1a1a2e",
  "bg-tertiary": "#252538",
  "border-color": "#2a2a3e",
  "text-primary": "#f4f4f9",
  "text-secondary": "#e0e0e0",
  "text-tertiary": "#c0c0c0",
  "text-muted": "#a0a0a0",
  "secondary-text": "#6cb4e8",
};

let env: Env;

beforeEach(async () => {
  env = {
    ROSTER: makeKV() as unknown as Env["ROSTER"],
    RATELIMIT: makeKV() as unknown as Env["RATELIMIT"],
    DB: makeDB() as unknown as Env["DB"],
    JWT_SECRET: "unit-test-secret-at-least-32-bytes-long!!",
    ALLOWED_ORIGINS: `${ORIGIN},https://greenvillediscgolf.com`,
    SESSION_TTL_SEC: "900",
    LIVE: undefined as unknown as Env["LIVE"],
    PHOTOS: undefined as unknown as Env["PHOTOS"],
  } as unknown as Env;
  await putMember(env.ROSTER as KVLike, {
    memberId: "m_jane",
    name: "Jane Doe",
    pdgaNo: "12345",
    udisc: "JaneD",
    pinHash: await hashPin(PIN),
    mustChangePin: true,
  });
});

function jsonRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://auth.example${path}`, {
    method,
    headers: { Origin: ORIGIN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function authedToken(): Promise<string> {
  const login = await worker.fetch(jsonRequest("/login", "POST", { identifier: "12345", pin: PIN }), env);
  const loginToken = ((await login.json()) as { token: string }).token;
  const setPin = await worker.fetch(jsonRequest("/set-pin", "POST", { newPin: "9999" }, { Authorization: `Bearer ${loginToken}` }), env);
  return ((await setPin.json()) as { token: string }).token;
}

describe("GET/PUT/DELETE /me/dashboard-theme", () => {
  it("401s without a usable token", async () => {
    expect((await worker.fetch(jsonRequest("/me/dashboard-theme", "GET"), env)).status).toBe(401);
  });

  it("rejects javascript wallpaper and incomplete tokens", async () => {
    const token = await authedToken();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await worker.fetch(jsonRequest("/me/dashboard-theme", "PUT", {
      theme: { mode: "dark", extractMode: "normal", palette: [], tokens: { primary: "#ff0000" }, wallpaper: "javascript:alert(1)" },
    }, auth), env)).status).toBe(400);
  });

  it("saves, returns, and clears a sanitized theme", async () => {
    const token = await authedToken();
    const auth = { Authorization: `Bearer ${token}` };
    const theme = {
      mode: "dark",
      extractMode: "forest",
      palette: ["#102010", "#ff6b35"],
      tokens: TOKENS,
      wallpaper: PNG,
    };
    const put = await worker.fetch(jsonRequest("/me/dashboard-theme", "PUT", { theme }, auth), env);
    expect(put.status).toBe(200);
    const stored = (await put.json()) as { theme: { extractMode: string; wallpaper: string | null } };
    expect(stored.theme.extractMode).toBe("forest");
    expect(stored.theme.wallpaper).toBe(PNG);

    const get = await worker.fetch(jsonRequest("/me/dashboard-theme", "GET", undefined, auth), env);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { theme: { tokens: { primary: string } } };
    expect(body.theme.tokens.primary).toBe("#ff6b35");

    const del = await worker.fetch(jsonRequest("/me/dashboard-theme", "DELETE", undefined, auth), env);
    expect(del.status).toBe(200);
    const empty = await worker.fetch(jsonRequest("/me/dashboard-theme", "GET", undefined, auth), env);
    expect(((await empty.json()) as { theme: null }).theme).toBeNull();
  });
});
