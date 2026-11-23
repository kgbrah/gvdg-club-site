import type { Env } from "./env.js";
import * as db from "./db.js";
import { requireAuth } from "./authz.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import {
  chooseUdiscPlayer,
  normUdiscPlayer,
  parseUdiscHistory,
  UDISC_HISTORY_MAX_CSV_CHARS,
  UDISC_HISTORY_MAX_ROUNDS,
} from "./imports/udisc-history.js";
import { summarizeUdiscRounds, type UdiscStatHole, type UdiscStatRound } from "./imports/udisc-stats.js";

const IMPORT_BODY_BYTES = 2_000_000;
const IMPORT_LIMIT = 8;
const IMPORT_WINDOW_SEC = 3600;

function publicRound(row: {
  id: number;
  player_name: string;
  course_name: string;
  layout_name: string;
  played_at: string;
  total: number | null;
  to_par: number | null;
  holes: string;
}) {
  let holes: unknown = [];
  try {
    holes = JSON.parse(row.holes || "[]");
  } catch {
    holes = [];
  }
  return {
    id: row.id,
    playerName: row.player_name,
    courseName: row.course_name,
    layoutName: row.layout_name,
    playedAt: row.played_at,
    total: row.total,
    toPar: row.to_par,
    holes: Array.isArray(holes) ? holes : [],
  };
}

function statRound(row: { course_name: string; layout_name: string; to_par: number | null; holes: string }): UdiscStatRound {
  let holes: UdiscStatHole[] = [];
  try {
    const parsed = JSON.parse(row.holes || "[]");
    if (Array.isArray(parsed)) {
      holes = parsed.flatMap((hole) => {
        const n = Number(hole?.hole);
        const strokes = Number(hole?.strokes);
        const par = hole?.par == null || hole.par === "" ? null : Number(hole.par);
        if (!Number.isInteger(n) || !Number.isInteger(strokes)) return [];
        return [{ hole: n, strokes, par: par != null && Number.isInteger(par) ? par : null }];
      });
    }
  } catch {
    holes = [];
  }
  return {
    courseName: row.course_name || "",
    layoutName: row.layout_name || "",
    toPar: typeof row.to_par === "number" && Number.isFinite(row.to_par) ? row.to_par : null,
    holes,
  };
}

export async function handleUdiscHistory(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  id?: number,
): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const memberId = claims.sub;

  if (method === "GET") {
    const requested = Number(new URL(request.url).searchParams.get("limit"));
    const limit = Number.isInteger(requested) && requested >= 1 && requested <= 200 ? requested : 50;
    const rows = await db.listUdiscHistory(env.DB, memberId, limit);
    const sources = await db.listUdiscStatSources(env.DB, memberId);
    return json({ rounds: rows.map(publicRound), stats: summarizeUdiscRounds(sources.map(statRound)) }, 200, origin);
  }

  if (method === "DELETE" && id != null) {
    const removed = await db.deleteUdiscHistory(env.DB, memberId, id);
    if (!removed) return json({ error: "not_found" }, 404, origin);
    return json({ ok: true }, 200, origin);
  }

  if (method === "DELETE") {
    await db.clearUdiscHistory(env.DB, memberId);
    return json({ ok: true }, 200, origin);
  }

  if (method !== "POST") return json({ error: "not_found" }, 404, origin);
  if (await kvRateLimited(env, "udisc-history:" + memberId, IMPORT_LIMIT, IMPORT_WINDOW_SEC)) {
    return json({ error: "rate_limited" }, 429, origin);
  }
  const body = await readJson(request, IMPORT_BODY_BYTES);
  const csv = body?.csv;
  if (typeof csv !== "string" || csv.length > UDISC_HISTORY_MAX_CSV_CHARS) {
    return json({ error: "unrecognized_csv" }, 400, origin);
  }
  const parsed = parseUdiscHistory(csv);
  if ("error" in parsed) return json({ error: parsed.error }, 400, origin);
  const requested = typeof body?.playerName === "string" ? body.playerName : null;
  const choice = chooseUdiscPlayer(parsed.players, {
    name: claims.member?.name,
    udisc: claims.member?.udisc,
  }, requested);
  if ("error" in choice) return json({ error: choice.error }, 400, origin);
  if ("players" in choice) return json({ error: "pick_player", players: choice.players }, 409, origin);
  const rounds = parsed.rounds.filter((round) => normUdiscPlayer(round.playerName) === normUdiscPlayer(choice.player));
  if (!rounds.length) return json({ error: "empty" }, 400, origin);
  if (rounds.length > UDISC_HISTORY_MAX_ROUNDS) return json({ error: "too_many" }, 400, origin);
  await db.upsertUdiscHistory(env.DB, memberId, rounds);
  return json({ saved: rounds.length, playerName: choice.player }, 200, origin);
}
