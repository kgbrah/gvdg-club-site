import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildTheme, themeStorageKey } from "../src/shared/dashboard-theme-model.js";
import {
  decodeJwtPayload,
  loadLocalPlayerTheme,
  paintPlayerTheme,
  syncPlayerTheme,
  THEME_EVENT,
  themeMemberIds,
  themeWithMode,
  togglePlayerThemeMode,
} from "../src/shared/player-theme-session.js";

function fakeJwt(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${json}.sig`;
}

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    data,
  };
}

function fakeEl() {
  const props = new Map();
  const classes = new Set();
  return {
    props,
    classes,
    style: {
      setProperty(name, value) { props.set(name, value); },
      removeProperty(name) { props.delete(name); },
    },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
    },
  };
}

test("decodeJwtPayload reads member sub from a session token", () => {
  const token = fakeJwt({ sub: "member_42", mustChangePin: false });
  assert.equal(decodeJwtPayload(token).sub, "member_42");
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
  assert.deepEqual(themeMemberIds({ token, pdgaNo: "12345" }), ["member_42", "12345", "me"]);
});

test("loadLocalPlayerTheme prefers the JWT member over the generic me key", () => {
  const token = fakeJwt({ sub: "member_42" });
  const mine = buildTheme({ preset: "Nord", mode: "dark" });
  const other = buildTheme({ preset: "Ember", mode: "light" });
  const storage = memoryStorage({
    [themeStorageKey("me")]: JSON.stringify(other),
    [themeStorageKey("member_42")]: JSON.stringify(mine),
  });
  const loaded = loadLocalPlayerTheme({ token, storage, sessionStorage: memoryStorage() });
  assert.equal(loaded.memberId, "member_42");
  assert.equal(loaded.theme.preset, "Nord");
  assert.equal(loaded.theme.mode, "dark");
});

test("loadLocalPlayerTheme ignores cached themes when no member token is present", () => {
  const leftover = buildTheme({ preset: "Ember", mode: "dark" });
  const storage = memoryStorage({
    [themeStorageKey("me")]: JSON.stringify(leftover),
    [themeStorageKey("12345")]: JSON.stringify(leftover),
  });
  const loaded = loadLocalPlayerTheme({
    storage,
    sessionStorage: memoryStorage({ gvdg_member_pdga: "12345" }),
  });
  assert.equal(loaded.theme, null);
  assert.equal(loaded.token, "");
});

test("paintPlayerTheme puts full tokens on the score page body", () => {
  const root = fakeEl();
  const wallpaper = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=";
  const theme = buildTheme({ preset: "Nord", mode: "dark", wallpaper });
  paintPlayerTheme(theme, root);
  assert.equal(root.props.get("--primary"), theme.tokens.primary);
  assert.equal(root.props.get("--bg-secondary"), theme.tokens["bg-secondary"]);
  assert.match(root.props.get("--player-theme-image"), /url\("data:image\/png/);
  assert.ok(root.classes.has("player-theme-active"));
  assert.ok(root.classes.has("player-theme-page"));
  paintPlayerTheme(null, root);
  assert.equal(root.props.size, 0);
  assert.equal(root.classes.size, 0);
});

test("syncPlayerTheme paints local immediately then replaces with remote", async () => {
  const token = fakeJwt({ sub: "member_42" });
  const localTheme = buildTheme({ preset: "Nord", mode: "dark" });
  const remoteTheme = buildTheme({ preset: "Ember", mode: "light" });
  const storage = memoryStorage({ [themeStorageKey("member_42")]: JSON.stringify(localTheme) });
  const root = fakeEl();
  const seen = [];
  const result = await syncPlayerTheme({
    root,
    storage,
    sessionStorage: memoryStorage({ gvdg_member_token: token }),
    requestImpl: async () => ({
      ok: true,
      json: async () => ({ theme: remoteTheme }),
    }),
    onTheme(theme, memberId) { seen.push({ preset: theme?.preset, memberId }); },
  });
  assert.equal(result.theme.preset, "Ember");
  assert.equal(root.props.get("--primary"), remoteTheme.tokens.primary);
  assert.deepEqual(seen.map((row) => row.preset), ["Nord", "Ember"]);
  assert.equal(JSON.parse(storage.getItem(themeStorageKey("member_42"))).preset, "Ember");
});

test("syncPlayerTheme clears a remotely deleted theme", async () => {
  const token = fakeJwt({ sub: "member_42" });
  const localTheme = buildTheme({ preset: "Nord", mode: "dark" });
  const storage = memoryStorage({ [themeStorageKey("member_42")]: JSON.stringify(localTheme) });
  const root = fakeEl();
  const result = await syncPlayerTheme({
    root,
    storage,
    sessionStorage: memoryStorage({ gvdg_member_token: token }),
    requestImpl: async () => ({ ok: true, json: async () => ({ theme: null }) }),
  });
  assert.equal(result.theme, null);
  assert.equal(root.props.size, 0);
  assert.equal(storage.getItem(themeStorageKey("member_42")), null);
});

test("syncPlayerTheme discards a remote theme after the session token changes", async () => {
  const first = fakeJwt({ sub: "member_42" });
  const second = fakeJwt({ sub: "member_99" });
  const localTheme = buildTheme({ preset: "Nord", mode: "dark" });
  const staleTheme = buildTheme({ preset: "Ember", mode: "light" });
  const storage = memoryStorage({ [themeStorageKey("member_42")]: JSON.stringify(localTheme) });
  const sessions = memoryStorage({ gvdg_member_token: first });
  const root = fakeEl();
  const result = await syncPlayerTheme({
    root,
    storage,
    sessionStorage: sessions,
    requestImpl: async () => {
      sessions.setItem("gvdg_member_token", second);
      return { ok: true, json: async () => ({ theme: staleTheme }) };
    },
  });
  assert.equal(result.theme.preset, "Nord");
  assert.equal(root.props.get("--primary"), localTheme.tokens.primary);
  assert.equal(JSON.parse(storage.getItem(themeStorageKey("member_42"))).preset, "Nord");
});

test("loadLocalPlayerTheme writes remote cache against the JWT member even if a fallback was painted", () => {
  const token = fakeJwt({ sub: "member_42" });
  const leftover = buildTheme({ preset: "Ember", mode: "dark" });
  const storage = memoryStorage({ [themeStorageKey("me")]: JSON.stringify(leftover) });
  const loaded = loadLocalPlayerTheme({ token, storage, sessionStorage: memoryStorage() });
  assert.equal(loaded.memberId, "member_42");
  assert.equal(loaded.theme.preset, "Ember");
});

test("togglePlayerThemeMode persists the flipped mode to the dashboard-theme API", async () => {
  const token = fakeJwt({ sub: "member_42" });
  const dark = buildTheme({ preset: "Nord", mode: "dark" });
  const calls = [];
  const next = togglePlayerThemeMode(dark, {
    root: fakeEl(),
    storage: memoryStorage(),
    memberId: "member_42",
    token,
    requestImpl: async (path, options) => {
      calls.push({ path, method: options.method, body: options.body });
      return { ok: true, json: async () => ({ theme: options.body?.theme }) };
    },
  });
  assert.equal(next.mode, "light");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/me/dashboard-theme");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].body.theme.mode, "light");
});

test("player theme chrome wires the sun/moon switch into custom theme mode", () => {
  const chrome = readFileSync(new URL("../src/shared/player-theme-chrome.js", import.meta.url), "utf8");
  assert.match(chrome, /togglePlayerThemeMode/);
  assert.match(chrome, /THEME_EVENT/);
  assert.match(chrome, /gvdg:member-dashboard-opened/);
  assert.equal(THEME_EVENT, "gvdg:player-theme");
});

test("themeWithMode rebuilds light and dark surfaces from the same palette", () => {
  const dark = buildTheme({ preset: "Nord", mode: "dark" });
  const light = themeWithMode(dark, "light");
  assert.equal(light.mode, "light");
  assert.deepEqual(light.palette, dark.palette);
  const darkLum = parseInt(dark.tokens["bg-primary"].slice(1, 3), 16);
  const lightLum = parseInt(light.tokens["bg-primary"].slice(1, 3), 16);
  assert.ok(lightLum > darkLum);
  const toggled = togglePlayerThemeMode(dark, { root: fakeEl(), storage: memoryStorage(), memberId: "member_42" });
  assert.equal(toggled.mode, "light");
});
