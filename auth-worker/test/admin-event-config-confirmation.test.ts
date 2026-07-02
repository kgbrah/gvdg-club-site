import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import { jsonObject } from "./json.js";
import { d1Database, d1Statement, memoryKv, workerEnv } from "./worker-test-env.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const MEMBERS = {
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};

type DbState = {
  configBinds?: readonly unknown[];
  updateCount: number;
};

function db(state: DbState): D1Database {
  return d1Database((sql) => {
    let binds: readonly unknown[] = [];
    return d1Statement({
      bind: (values) => {
        binds = values;
      },
      first: () => {
        if (/INSERT INTO event_config/i.test(sql)) {
          state.configBinds = binds;
          state.updateCount += 1;
          return { event_id: binds[0], registration_open: binds[1], entry_fee_cents: binds[2], divisions: binds[5] };
        }
        return null;
      },
    });
  });
}

function env(state: DbState) {
  return workerEnv({ roster: memoryKv(MEMBERS), db: db(state), secret: SECRET, origin: ORIGIN });
}

async function token() {
  return signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900);
}

async function putConfig(state: DbState, body: Record<string, unknown>) {
  return worker.fetch(
    new Request("https://w/admin/events/5/config", {
      method: "PUT",
      headers: { Origin: ORIGIN, authorization: "Bearer " + await token(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env(state),
  );
}

function state(): DbState {
  return { updateCount: 0 };
}

describe("admin event registration config confirmation", () => {
  it("requires confirmation before updating public registration settings", async () => {
    const dbState = state();
    const res = await putConfig(dbState, { registration_open: true, entry_fee_cents: 1000, divisions: ["MA1"], play_format: "singles" });

    expect(res.status).toBe(409);
    await expect(jsonObject(res)).resolves.toMatchObject({ error: "event_config_confirmation_required" });
    expect(dbState.updateCount).toBe(0);
    expect(dbState.configBinds).toBeUndefined();
  });

  it("updates public registration settings after confirmation", async () => {
    const dbState = state();
    const res = await putConfig(dbState, { registration_open: true, entry_fee_cents: 1000, divisions: ["MA1"], play_format: "singles", confirm_event_config_update: true });

    expect(res.status).toBe(200);
    expect(dbState.updateCount).toBe(1);
    expect(dbState.configBinds).toEqual([5, 1, 1000, null, null, "[\"MA1\"]", "singles", null]);
  });
});
