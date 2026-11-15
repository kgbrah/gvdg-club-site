import { expect, it } from "vitest";
import { LiveEventDO } from "../src/live.js";
import type { LiveEnv, LiveState } from "../src/live-types.js";
import type { WatchScope } from "../src/watch-do.js";

function fixture() {
  const stored = new Map<string, unknown>();
  const state = {
    storage: {
      get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") stored.set(key, structuredClone(value));
        else for (const [name, entry] of Object.entries(key)) stored.set(name, structuredClone(entry));
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  } satisfies LiveState;
  const env = {} as LiveEnv;
  let live = new LiveEventDO(state, env);
  function send(path: string, body: unknown, actor = "m_watch", admin = false) {
    return live.fetch(new Request(`https://do/${path}`, {
      method: "POST", body: JSON.stringify(body), headers: { "X-Auth-Member": actor, "X-Auth-Admin": String(admin) },
    }));
  }
  function start() {
    return send("start", {
      eventId: 6, startedAt: "2026-08-12T12:00:00Z", holes: [{ hole: 1, par: 3 }],
      players: [
        { memberId: "m_watch", name: "Wrist scorer", cardId: "c1" },
        { memberId: "m_other", name: "Different card", cardId: "c2" },
      ],
    });
  }
  function reload() { live = new LiveEventDO(state, env); }
  return { send, start, reload };
}

it("shares authorized score votes, survives duplicate delivery after restart, and rejects stale updates", async () => {
  const { send, start, reload } = fixture();
  expect((await start()).status).toBe(200);
  const card = await send("watch-card", {});
  expect(card.status).toBe(200);
  const { scope } = await card.json() as { scope: WatchScope };
  const watch = { scope, deviceId: "device-one" };
  const op = { sequence: 1, targetId: "player:0", binding: "0", hole: 1, previous: null, strokes: 4 };
  const phone = { targetId: "player:0", hole: 1, strokes: 3 };
  expect((await send("score", phone)).status).toBe(200);
  const conflict = await send("watch-score", { ...watch, op });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "watch_score_conflict", previous: 3 });

  const corrected = { ...op, previous: 3 };
  expect(await (await send("watch-score", { ...watch, op: corrected })).json()).toEqual({ sequence: 1 });
  expect((await send("score", { ...phone, strokes: 6 })).status).toBe(200);
  reload();
  expect(await (await send("watch-score", { ...watch, op: corrected })).json()).toEqual({ sequence: 1 });
  expect((await send("watch-score", { ...watch, op: { ...corrected, strokes: 9 } })).status).toBe(409);
  expect((await send("watch-score", { ...watch, op: { ...corrected, sequence: 2, targetId: "player:1", binding: "1" } })).status).toBe(403);
  const current = await send("watch-card", watch);
  expect(await current.json()).toMatchObject({ lastSequence: 1, targets: [{ id: "player:0", votes: { 1: 6 } }] });

  expect((await send("cancel", {}, "m_admin", true)).status).toBe(200);
  expect((await start()).status).toBe(200);
  const restarted = await send("watch-score", { ...watch, op: corrected });
  expect(restarted.status).toBe(409);
  expect(await restarted.json()).toEqual({ error: "watch_round_changed" });
});
