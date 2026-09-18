import assert from "node:assert/strict";
import test from "node:test";

import { createWakeLock } from "../src/shared/wake-lock.js";

test("wake lock requests a screen lock and re-acquires on visibility", async () => {
  const listeners = new Map();
  let released = 0;
  const sentinels = [];
  const documentRef = {
    visibilityState: "visible",
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const navigatorRef = {
    wakeLock: {
      async request(type) {
        assert.equal(type, "screen");
        const sentinel = {
          addEventListener() {},
          release() { released += 1; },
        };
        sentinels.push(sentinel);
        return sentinel;
      },
    },
  };
  const lock = createWakeLock({ navigatorRef, documentRef });
  await lock.start();
  assert.equal(lock.active, true);
  assert.equal(sentinels.length, 1);
  documentRef.visibilityState = "visible";
  await listeners.get("visibilitychange")();
  assert.equal(sentinels.length, 2);
  lock.stop();
  assert.equal(lock.active, false);
  assert.equal(released, 1);
  assert.equal(listeners.has("visibilitychange"), false);
});

test("wake lock no-ops when the API is missing", async () => {
  const lock = createWakeLock({ navigatorRef: {}, documentRef: { addEventListener() {}, removeEventListener() {} } });
  await lock.start();
  assert.equal(lock.active, false);
  lock.stop();
});

test("wake lock start is idempotent", async () => {
  let requests = 0;
  let listeners = 0;
  const documentRef = {
    visibilityState: "visible",
    addEventListener() { listeners += 1; },
    removeEventListener() { listeners = Math.max(0, listeners - 1); },
  };
  const navigatorRef = {
    wakeLock: {
      async request() {
        requests += 1;
        return { addEventListener() {}, release() {} };
      },
    },
  };
  const lock = createWakeLock({ navigatorRef, documentRef });
  await lock.start();
  await lock.start();
  assert.equal(lock.active, true);
  assert.equal(requests, 1);
  assert.equal(listeners, 1);
  lock.stop();
  assert.equal(listeners, 0);
});
