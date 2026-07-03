import { describe, expect, it } from "vitest";
import { call, token, type DbState } from "./admin-event-fixture.js";

describe("admin event management", () => {
  it("creates an event and a basic layout in the same request", async () => {
    const state: DbState = {};
    const res = await call("/admin/events", "POST", {
      type: "tournament",
      name: "Summer Flex",
      course_id: 7,
      layout: { name: "Gold", hole_count: 18, default_par: 3 },
    }, await token("m_admin"), state);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { layout_id: number; created_by: string }; layout: { id: number } };
    expect(body.layout.id).toBe(44);
    expect(body.event).toMatchObject({ layout_id: 44, created_by: "m_admin" });
    expect(state.eventBinds?.[6]).toBe(44);
    expect(state.layoutBinds?.[0]).toBe(7);
    expect(state.layoutBinds?.[1]).toBe("Gold");
    expect(state.layoutBinds?.[3]).toBe(54);
    const holes = JSON.parse(String(state.layoutBinds?.[2])) as { hole: number; par: number }[];
    expect(holes).toHaveLength(18);
    expect(holes.every((h) => h.par === 3)).toBe(true);
  });

  it("lets admins add and remove manual event players", async () => {
    const state: DbState = {};
    const jwt = await token("m_admin");
    const add = await call("/admin/events/9/players", "POST", { name: "Walk On", pdga_no: "12345", division: "MA1", team: "A" }, jwt, state);
    expect(add.status).toBe(201);
    expect(state.playerBinds).toEqual([9, null, "Walk On", "12345", "MA1", "A"]);

    const unconfirmed = await call("/admin/events/9/players/88", "DELETE", undefined, jwt, state);
    expect(unconfirmed.status).toBe(409);
    expect(state.removedPlayer).toBeUndefined();

    const remove = await call("/admin/events/9/players/88", "DELETE", { confirm_event_player_delete: true }, jwt, state);
    expect(remove.status).toBe(200);
    expect(state.removedPlayer).toBe(88);
  });

  it("requires a team when admins add manual players to a team-format event", async () => {
    const state: DbState = {
      eventRow: { id: 9, format: "matchplay" },
      eventConfigRow: { play_format: "doubles" },
    };
    const res = await call("/admin/events/9/players", "POST", { name: "Walk On" }, await token("m_admin"), state);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "team_required" });
    expect(state.playerBinds).toBeUndefined();
  });

  it("does not require a team when admins add manual players to matchplay singles", async () => {
    const state: DbState = {
      eventRow: { id: 9, format: "matchplay" },
      eventConfigRow: { play_format: "singles" },
    };
    const res = await call("/admin/events/9/players", "POST", { name: "Walk On" }, await token("m_admin"), state);

    expect(res.status).toBe(201);
    expect(state.playerBinds).toEqual([9, null, "Walk On", null, null, null]);
  });

  it("includes course and layout details for open registration events", async () => {
    const res = await call("/registration/open", "GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { course_name?: string; layout_name?: string; total_par?: number }[] };
    expect(body.events[0]).toMatchObject({ course_name: "West Meadowbrook", layout_name: "Gold", total_par: 54 });
  });

  it("scopes admin registration updates to the selected event", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9/registrations/44", "PATCH", { starting_hole: 7, checked_in: true }, await token("m_admin"), state);

    expect(res.status).toBe(200);
    expect(state.registrationUpdateBinds).toEqual([7, 1, 44, 9]);
  });

  it("lets admins edit a registered player's team name", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9/registrations/44", "PATCH", { team: "Team Fox" }, await token("m_admin"), state);

    expect(res.status).toBe(200);
    expect(state.registrationUpdateBinds).toEqual(["Team Fox", 44, 9]);
  });

  it("clears nullable admin registration fields when explicitly sent as null", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9/registrations/44", "PATCH", { starting_hole: null }, await token("m_admin"), state);

    expect(res.status).toBe(200);
    expect(state.registrationUpdateBinds).toEqual([null, 44, 9]);
  });

  it("requires confirmation before changing paid registration status", async () => {
    const jwt = await token("m_admin");
    const unconfirmedState: DbState = {};
    const unconfirmed = await call("/admin/events/9/registrations/44", "PATCH", { paid_entry: true }, jwt, unconfirmedState);

    expect(unconfirmed.status).toBe(409);
    expect(unconfirmedState.registrationUpdateBinds).toBeUndefined();

    const confirmedState: DbState = {};
    const confirmed = await call(
      "/admin/events/9/registrations/44",
      "PATCH",
      { paid_entry: true, confirm_paid_entry_change: true },
      jwt,
      confirmedState,
    );

    expect(confirmed.status).toBe(200);
    expect(confirmedState.registrationUpdateBinds).toEqual([1, 44, 9]);
  });

  it("requires confirmation and a winner before resolving ace pot payout", async () => {
    const jwt = await token("m_admin");
    const unconfirmedState: DbState = {};
    const unconfirmed = await call("/admin/events/9/ace-pot", "PUT", { status: "paid_out", winner_name: "Ace Winner", carryover_in_cents: 2500 }, jwt, unconfirmedState);

    expect(unconfirmed.status).toBe(409);
    expect(unconfirmedState.acePotBinds).toBeUndefined();

    const missingWinnerState: DbState = {};
    const missingWinner = await call("/admin/events/9/ace-pot", "PUT", { status: "paid_out", carryover_in_cents: 2500, confirm_ace_pot_resolution: true }, jwt, missingWinnerState);

    expect(missingWinner.status).toBe(400);
    expect(missingWinnerState.acePotBinds).toBeUndefined();

    const confirmedState: DbState = {};
    const confirmed = await call(
      "/admin/events/9/ace-pot",
      "PUT",
      { status: "paid_out", winner_name: "Ace Winner", carryover_in_cents: 2500, confirm_ace_pot_resolution: true },
      jwt,
      confirmedState,
    );

    expect(confirmed.status).toBe(200);
    expect(confirmedState.acePotBinds?.slice(0, 6)).toEqual([9, 2500, "paid_out", null, "Ace Winner", null]);
    expect(typeof confirmedState.acePotBinds?.[6]).toBe("string");
  });

  it("rejects direct lifecycle status writes that must go through live scoring", async () => {
    const jwt = await token("m_admin");

    const patchLive = await call("/admin/events/9", "PATCH", { status: "live" }, jwt);
    expect(patchLive.status).toBe(409);

    const patchFinal = await call("/admin/events/9", "PATCH", { status: "final" }, jwt);
    expect(patchFinal.status).toBe(409);

    const cancelLive = await call("/admin/events/9", "PATCH", { status: "cancelled" }, jwt, { eventStatus: "live" });
    expect(cancelLive.status).toBe(409);

    const createFinal = await call("/admin/events", "POST", { type: "tournament", name: "Bad final", status: "final" }, jwt);
    expect(createFinal.status).toBe(409);
  });

  it("requires explicit confirmation before updating public event details", async () => {
    const jwt = await token("m_admin");
    const unconfirmedState: DbState = {};
    const unconfirmed = await call("/admin/events/9", "PATCH", { name: "Renamed Flex", date: "2026-08-01" }, jwt, unconfirmedState);

    expect(unconfirmed.status).toBe(409);
    await expect(unconfirmed.json()).resolves.toMatchObject({ error: "event_details_confirmation_required" });
    expect(unconfirmedState.updateEventBinds).toBeUndefined();

    const confirmedState: DbState = {};
    const confirmed = await call(
      "/admin/events/9",
      "PATCH",
      { name: "Renamed Flex", date: "2026-08-01", confirm_event_details_update: true },
      jwt,
      confirmedState,
    );

    expect(confirmed.status).toBe(200);
    expect(confirmedState.updateEventBinds?.slice(0, 10)).toEqual([
      0, null,
      1, "Renamed Flex",
      0, null,
      0, null,
      1, "2026-08-01",
    ]);
    expect(confirmedState.updateEventBinds?.at(-1)).toBe(9);
  });

  it("blocks deleting events that already have operational records", async () => {
    const state: DbState = { eventDeleteBlockers: { registrations: 1 } };
    const res = await call("/admin/events/9", "DELETE", { confirm_event_delete: true }, await token("m_admin"), state);

    expect(res.status).toBe(409);
    expect(state.deleteEventId).toBeUndefined();
  });

  it("requires explicit confirmation before deleting empty scheduled events", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9", "DELETE", undefined, await token("m_admin"), state);

    expect(res.status).toBe(409);
    expect(state.deleteEventId).toBeUndefined();
  });

  it("still deletes empty scheduled events after explicit confirmation", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9", "DELETE", { confirm_event_delete: true }, await token("m_admin"), state);

    expect(res.status).toBe(200);
    expect(state.deleteEventId).toBe(9);
  });
});
