// Admin › Live rounds: every casual round still live, by its round code, so an admin can open it or end a ghost (a
// card someone started and never finished, which keeps showing "Casual round in progress" on players' Home screens).
//
//   GET /admin/rounds/active -> { rounds: [{ code, courseName, layoutName, startedAt, lastActivity, players, holes,
//                                            holesScored }] }   (newest activity first)
//
// A casual round lives only in its Durable Object until it's finished, so the list is built from the two places a
// started round is written down: the live round index (course traffic) and casual_round_sharing (every member-started
// round gets a row there). A code with a sharing row but no saved round was never finished, so it may be a ghost.
// Each candidate's Durable Object says whether it is really still live. Ending one is the existing admin
// POST /rounds/:code/cancel. Bounded for the Free plan: at most MAX_CHECKS Durable Object reads per request.
import { adminGate } from "./authz.js";
import { forgetLiveRound } from "./db-live-index.js";
import type { Env } from "./env.js";
import { json } from "./http.js";

const MAX_CHECKS = 35;
const UNFINISHED_SHARED = 30;

export interface ActiveRoundSummary {
  code: string;
  courseName: string;
  layoutName: string;
  startedAt: string | null;
  lastActivity: string | null;
  players: string[];
  holes: number;
  holesScored: number;
}

const ROUND_CODE = /^[A-Z0-9]{3,12}$/;

/** The codes worth asking about: indexed live rounds first, then member-started rounds that were never saved. */
async function candidateCodes(env: Env): Promise<{ codes: string[]; indexed: Set<string> }> {
  const [index, unfinished] = await Promise.all([
    env.DB.prepare("SELECT key FROM live_round_index WHERE key LIKE 'round:%' ORDER BY started_at DESC LIMIT 40").all<{ key: string }>(),
    env.DB.prepare(
      `SELECT s.round_code AS code FROM casual_round_sharing s
       WHERE NOT EXISTS (SELECT 1 FROM casual_rounds r WHERE r.round_code = s.round_code COLLATE NOCASE)
       ORDER BY s.rowid DESC LIMIT ${UNFINISHED_SHARED}`,
    ).all<{ code: string }>(),
  ]);
  const indexed = new Set<string>();
  const codes: string[] = [];
  for (const row of index.results ?? []) {
    const code = String(row.key).slice("round:".length).toUpperCase();
    if (ROUND_CODE.test(code) && !indexed.has(code)) { indexed.add(code); codes.push(code); }
  }
  for (const row of unfinished.results ?? []) {
    const code = String(row.code || "").toUpperCase();
    if (ROUND_CODE.test(code) && !codes.includes(code)) codes.push(code);
  }
  return { codes: codes.slice(0, MAX_CHECKS), indexed };
}

/** Every casual round still live (by its Durable Object), newest activity first. Drops dead rows from the index. */
export async function activeRounds(env: Env): Promise<ActiveRoundSummary[]> {
  const { codes, indexed } = await candidateCodes(env);
  const rounds = await Promise.all(codes.map(async (code) => {
    try {
      const response = await env.LIVE.get(env.LIVE.idFromName("round:" + code)).fetch("https://do/summary");
      const summary = await response.json().catch(() => null) as Partial<ActiveRoundSummary> & { status?: string } | null;
      if (!summary || summary.status !== "live") {
        if (indexed.has(code)) await forgetLiveRound(env.DB, "round:" + code).catch(() => {});
        return null;
      }
      return {
        code,
        courseName: String(summary.courseName || ""),
        layoutName: String(summary.layoutName || ""),
        startedAt: summary.startedAt || null,
        lastActivity: summary.lastActivity || summary.startedAt || null,
        players: Array.isArray(summary.players) ? summary.players.map(String).slice(0, 12) : [],
        holes: Number(summary.holes) || 0,
        holesScored: Number(summary.holesScored) || 0,
      };
    } catch {
      return null;
    }
  }));
  return rounds.filter((round): round is ActiveRoundSummary => round != null)
    .sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")));
}

export async function handleActiveRounds(request: Request, env: Env, origin: string | null): Promise<Response> {
  const gate = await adminGate(request, env, origin);
  if (gate instanceof Response) return gate;
  return json({ rounds: await activeRounds(env) }, 200, origin, { "Cache-Control": "no-store" });
}
