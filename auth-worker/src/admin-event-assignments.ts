import { assignShotgun, assignTeams } from "./assign.js";
import * as db from "./db.js";
import { json } from "./http.js";

type AssignmentBase = {
  readonly database: db.D1Like;
  readonly eventId: number;
  readonly registrationIds: readonly number[];
  readonly shuffle: boolean;
  readonly origin: string | null;
};

type StartingHoleAssignmentInput = AssignmentBase & {
  readonly holes: readonly number[];
  readonly groupSize: number;
};

type TeamAssignmentInput = AssignmentBase & {
  readonly options: { readonly size: number } | { readonly count: number };
};

function registrationOrder(input: AssignmentBase): number[] {
  return input.shuffle ? shuffle(input.registrationIds) : [...input.registrationIds];
}

function shuffle(arr: readonly number[]): number[] {
  const pool = [...arr];
  const out: number[] = [];
  while (pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    const [value] = pool.splice(index, 1);
    if (value !== undefined) out.push(value);
  }
  return out;
}

export async function assignRegistrationStartingHoles(input: StartingHoleAssignmentInput): Promise<Response | null> {
  const order = registrationOrder(input);
  const assigned = assignShotgun(order.map(String), [...input.holes], input.groupSize);
  const updates: Promise<unknown>[] = [];
  for (let i = 0; i < order.length; i++) {
    const rid = order[i];
    const assignment = assigned[i];
    if (rid == null || assignment == null) return json({ error: "invalid_assignment" }, 500, input.origin);
    updates.push(db.adminUpdateRegistration(input.database, input.eventId, rid, { starting_hole: assignment.hole }));
  }
  await Promise.all(updates);
  return null;
}

export async function assignRegistrationTeams(input: TeamAssignmentInput): Promise<Response | null> {
  const order = registrationOrder(input);
  const assigned = assignTeams(order.map(String), input.options);
  const updates: Promise<unknown>[] = [];
  for (let i = 0; i < order.length; i++) {
    const rid = order[i];
    const assignment = assigned[i];
    if (rid == null || assignment == null) return json({ error: "invalid_assignment" }, 500, input.origin);
    updates.push(db.adminUpdateRegistration(input.database, input.eventId, rid, { team: assignment.team }));
  }
  await Promise.all(updates);
  return null;
}
