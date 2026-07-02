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

type ContentTable = "leagues" | "fundraisers" | "meetings";

type DeleteCase = {
  readonly label: string;
  readonly path: string;
  readonly table: ContentTable;
  readonly confirmField: string;
  readonly error: string;
};

type DbState = {
  deleted?: { readonly table: ContentTable; readonly id: number };
};

const cases = [
  { label: "league", path: "/admin/leagues/7", table: "leagues", confirmField: "confirm_league_delete", error: "league_delete_confirmation_required" },
  { label: "fundraiser", path: "/admin/fundraisers/8", table: "fundraisers", confirmField: "confirm_fundraiser_delete", error: "fundraiser_delete_confirmation_required" },
  { label: "meeting", path: "/admin/meetings/9", table: "meetings", confirmField: "confirm_meeting_delete", error: "meeting_delete_confirmation_required" },
] as const satisfies readonly DeleteCase[];

function db(state: DbState): D1Database {
  return d1Database((sql) => {
    let binds: readonly unknown[] = [];
    return d1Statement({
      bind: (values) => {
        binds = values;
      },
      run: () => {
        if (/DELETE FROM leagues WHERE id = \?/i.test(sql)) state.deleted = { table: "leagues", id: Number(binds[0]) };
        if (/DELETE FROM fundraisers WHERE id = \?/i.test(sql)) state.deleted = { table: "fundraisers", id: Number(binds[0]) };
        if (/DELETE FROM meetings WHERE id = \?/i.test(sql)) state.deleted = { table: "meetings", id: Number(binds[0]) };
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

async function call(path: string, body?: Record<string, unknown>, state: DbState = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, authorization: "Bearer " + await token() };
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method: "DELETE", headers, body: body ? JSON.stringify(body) : undefined }), env(state));
}

describe("admin content delete confirmation", () => {
  for (const item of cases) {
    it(`requires confirmation before deleting a ${item.label}`, async () => {
      const state: DbState = {};
      const res = await call(item.path, undefined, state);

      expect(res.status).toBe(409);
      await expect(jsonObject(res)).resolves.toMatchObject({ error: item.error });
      expect(state.deleted).toBeUndefined();
    });

    it(`deletes a ${item.label} after explicit confirmation`, async () => {
      const state: DbState = {};
      const res = await call(item.path, { [item.confirmField]: true }, state);

      expect(res.status).toBe(200);
      expect(state.deleted).toEqual({ table: item.table, id: Number(item.path.split("/").at(-1)) });
    });
  }
});
