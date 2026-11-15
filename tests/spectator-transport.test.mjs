import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptSpectatorSnapshot, createSpectatorTransport, spectatorBackoff, spectatorUpdateAge,
} from "../src/score-app/spectator-transport.js";
import { clipsForStanding } from "../src/score-app/throw-film.js";
import { spectatorSocketProtocols, watchKeyFromLocation, watchUrl } from "../src/shared/spectator-link.js";

const at = Date.UTC(2026, 10, 14, 20);
const key = "0a".repeat(24);
const flush = async () => { for (let count = 0; count < 4; count++) await Promise.resolve(); };
const board = (rev, fields = {}) => ({ status: "live", rev, recoveryRoundId: "river", updatedAt: new Date(at).toISOString(), observedAt: at + rev, ...fields });

function clock() {
  let now = at;
  let sequence = 0;
  const timer = new Map();
  const add = (fn, ms, interval) => {
    const token = ++sequence;
    timer.set(token, { time: now + ms, fn, interval });
    return token;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: (id) => timer.delete(id),
    clearInterval: (id) => timer.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const [id, next] = [...timer].sort((a, b) => a[1].time - b[1].time)[0] || [];
        if (!next || next.time > end) break;
        now = next.time;
        if (next.interval) next.time += next.interval;
        else timer.delete(id);
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

class Socket extends EventTarget {
  readyState = 0;
  sent = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  disconnect(code = 1006) {
    this.readyState = 3;
    const event = new Event("close");
    event.code = code;
    this.dispatchEvent(event);
  }
  close() { this.readyState = 3; }
  send(data) { this.sent.push(data); }
}

function transport(fetchResponses = []) {
  const timers = clock();
  const sockets = [];
  const states = [];
  let fetching = 0;
  const feed = createSpectatorTransport({
    fetchSnapshot: async () => { fetching += 1; return await (fetchResponses.shift() ?? { status: 503 }); },
    openSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    onState: (state) => states.push(state),
    now: timers.now,
    random: () => 0.5,
    timers,
    online: () => true,
  });
  return { timers, feed, sockets, states, current: () => states.at(-1), fetching: () => fetching };
}

test("recover missed scores on reconnect and ignore delayed HTTP and socket revisions", async () => {
  let finishRefresh;
  const refresh = new Promise((resolve) => { finishRefresh = resolve; });
  const f = transport([{ status: 200, snapshot: board(1) }, refresh, { status: 200, snapshot: board(7) }]);
  f.feed.start();
  assert.equal(f.current().phase, "connecting");
  await flush();
  assert.equal(f.current().snapshot.rev, 1);
  f.sockets[0].open();
  f.sockets[0].message({ type: "snapshot", ...board(3) });
  assert.equal(f.current().phase, "live");
  finishRefresh({ status: 200, snapshot: board(2) });
  await flush();
  assert.equal(f.current().snapshot.rev, 3);
  f.sockets[0].message({ type: "snapshot", ...board(1) });
  assert.equal(f.current().snapshot.rev, 3);
  f.sockets[0].disconnect();
  assert.equal(f.current().phase, "reconnecting");
  assert.equal(f.current().snapshot.rev, 3);
  await f.timers.advance(1_000);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.current().snapshot.rev, 7);
  f.sockets[0].message({ type: "snapshot", ...board(99) });
  assert.equal(f.current().snapshot.rev, 7);
  f.sockets[1].open();
  f.sockets[1].message({ type: "snapshot", ...board(8, { status: "final" }) });
  assert.equal(f.current().phase, "final");
  assert.equal(f.current().snapshot.rev, 8);
  assert.equal(f.sockets[1].readyState, 3);
  f.feed.stop();
});

test("a silent socket becomes stale while retaining authorized scores and a revoked watch link clears them", async () => {
  const f = transport([{ status: 200, snapshot: board(4) }, { status: 503 }, { status: 404 }]);
  f.feed.start();
  await flush();
  f.sockets[0].open();
  f.sockets[0].message({ type: "snapshot", ...board(4) });
  await f.timers.advance(10_000);
  assert.deepEqual(f.sockets[0].sent, ["ping"]);
  await f.timers.advance(20_000);
  assert.equal(f.current().phase, "stale");
  assert.equal(f.current().snapshot.rev, 4);
  f.feed.resume();
  await flush();
  assert.equal(f.current().phase, "unavailable");
  assert.equal(f.current().snapshot, null);
  f.feed.stop();

  const revoked = transport([{ status: 200, snapshot: board(1) }, { status: 404 }]);
  revoked.feed.start();
  await flush();
  revoked.sockets[0].message({ type: "snapshot", ...board(1) });
  revoked.sockets[0].disconnect(4403);
  assert.equal(revoked.current().snapshot, null);
  await flush();
  assert.equal(revoked.current().phase, "unavailable");
  revoked.feed.stop();
});

test("final replays revalidate access and backoff and last-update age are bounded", async () => {
  const f = transport([{ status: 200, snapshot: board(2, { status: "final" }) }, { status: 404 }]);
  f.feed.start();
  await flush();
  assert.equal(f.current().phase, "final");
  assert.equal(f.sockets.length, 0);
  await f.timers.advance(20_000);
  assert.equal(f.current().phase, "unavailable");
  assert.equal(f.current().snapshot, null);
  assert.equal(spectatorBackoff(0, () => 0), 800);
  assert.equal(spectatorBackoff(15, () => 1), 28_800);
  assert.equal(spectatorUpdateAge("2026-11-14 19:58:59", at), "1 min ago");
  assert.equal(spectatorUpdateAge(at + 60_000, at), "just now");
  f.feed.stop();
});

test("ignores stale generations and binds clips to their archived original player indices", () => {
  const newer = board(8);
  assert.equal(acceptSpectatorSnapshot(newer, board(3), board(2)), false);
  assert.equal(acceptSpectatorSnapshot(newer, board(1, { recoveryRoundId: "old" }), board(2)), false);
  assert.equal(acceptSpectatorSnapshot(newer, board(1, { recoveryRoundId: "new" })), true);
  const clip = { mediaPath: "/watch-round/clips/1/media", playerIndex: 1, playerName: "Same Name", generation: "river" };
  assert.deepEqual(clipsForStanding([clip], { name: "Same Name", playerIndexes: [1], clipPlayerIndexes: [] }, "river"), []);
  assert.deepEqual(clipsForStanding([clip], { name: "Same Name", playerIndexes: [1], clipPlayerIndexes: [1] }, "river"), [clip]);
  assert.deepEqual(clipsForStanding([clip], { name: "Same Name", playerIndexes: [1] }, "another-round"), []);
});

test("watch link copies no scoring code or session token", () => {
  const launch = new URL("https://gvdgclub.com/score.html?round=INVITE&gt=secret");
  const share = watchUrl("score.html?watch=1", launch, key);
  assert.equal(share, "https://gvdgclub.com/score.html?watch=1#wl=" + key);
  assert.equal(watchKeyFromLocation(new URL(share)), key);
  assert.deepEqual(spectatorSocketProtocols(key, "private-account-token"), ["gvdg-watch-v1", "w." + key]);
});
