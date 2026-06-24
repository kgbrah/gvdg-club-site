// LiveEventDO — one Durable Object per in-progress event. Holds the live scorecard (layout pars +
// players + per-hole strokes) in DO storage, accepts score submissions, pushes leaderboard updates to
// WebSocket viewers, and on finalize writes results to D1 and marks the event final.
//
// Auth is enforced by the Worker BEFORE forwarding here (start/score/finalize are admin-gated; the
// snapshot + ws reads are public). The DO trusts requests it receives.

import * as db from "./db.js";
import { computeLeaderboard, finalizeStandings, type PlayerState } from "./scoring.js";

interface LiveEnv {
  DB: db.D1Like;
}
interface LiveMeta {
  eventId: number;
  holes: { hole: number; par: number }[];
  status: "live" | "final";
  startedAt: string;
  // Single-use, ROUND-SCOPED hole overrides (e.g. short baskets today). They live only here, in the
  // live round — the course layout is never touched, so the hole reverts to its verified value after
  // the round. Keyed by hole number (string for JSON safety).
  overrides?: Record<string, { par?: number; distance_ft?: number }>;
}
interface StartBody {
  eventId: number;
  holes: { hole: number; par: number }[];
  players: { memberId?: string | null; name: string; division?: string | null; startingHole?: number | null }[];
  startedAt?: string;
}
interface ScoreBody {
  memberId?: string | null;
  index?: number;
  name?: string;
  hole: number;
  strokes: number;
}
interface OverrideBody {
  hole: number;
  par?: number | null;
  distance_ft?: number | null;
  clear?: boolean;
}

const j = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export class LiveEventDO {
  private state: DurableObjectState;
  private env: LiveEnv;
  private sockets = new Set<WebSocket>();
  private loaded = false;
  private meta: LiveMeta | null = null;
  private players: PlayerState[] = [];

  constructor(state: DurableObjectState, env: LiveEnv) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.meta = (await this.state.storage.get<LiveMeta>("meta")) ?? null;
    this.players = (await this.state.storage.get<PlayerState[]>("players")) ?? [];
    this.loaded = true;
  }
  private async persist(): Promise<void> {
    await this.state.storage.put("meta", this.meta);
    await this.state.storage.put("players", this.players);
  }

  async fetch(request: Request): Promise<Response> {
    await this.load();
    const action = new URL(request.url).pathname.split("/").filter(Boolean).pop();
    if (action === "ws") return this.handleWs(request);
    if (request.method === "GET") return j(this.snapshot());
    const body = await request.json().catch(() => ({}));
    if (action === "start") return this.start(body as StartBody);
    if (action === "score") return this.score(body as ScoreBody);
    if (action === "override") return this.override(body as OverrideBody);
    if (action === "finalize") return this.finalize();
    return j({ error: "not_found" }, 404);
  }

  /** meta.holes with any round-scoped overrides applied — the par the scorecard/leaderboard use, plus
   *  an optional temporary distance + an `overridden` flag for the tee-sign render. */
  private resolvedHoles(): { hole: number; par: number; distance_ft: number | null; overridden: boolean }[] {
    const ov = this.meta?.overrides ?? {};
    return (this.meta?.holes ?? []).map((h) => {
      const o = ov[String(h.hole)];
      return { hole: h.hole, par: o?.par ?? h.par, distance_ft: o?.distance_ft ?? null, overridden: !!o };
    });
  }

  private snapshot() {
    const holes = this.resolvedHoles();
    return {
      status: this.meta?.status ?? "none",
      eventId: this.meta?.eventId ?? null,
      holes, // {hole, par, distance_ft, overridden} — par/distance reflect any round override
      // players (with per-hole scores + their stable index) drive the scorekeeper grid;
      // standings drive the public leaderboard.
      players: this.players.map((p, index) => ({ index, memberId: p.memberId, name: p.name, division: p.division ?? null, startingHole: p.startingHole ?? null, scores: p.scores })),
      standings: computeLeaderboard(holes, this.players),
      updatedAt: this.meta?.startedAt ?? null,
    };
  }

  private async start(b: StartBody): Promise<Response> {
    const holes = (Array.isArray(b.holes) ? b.holes : [])
      .filter((h) => h && typeof h.hole === "number" && typeof h.par === "number")
      .map((h) => ({ hole: h.hole, par: h.par }));
    if (!b.eventId || holes.length === 0) return j({ error: "invalid_start" }, 400);
    this.meta = { eventId: b.eventId, holes, status: "live", startedAt: b.startedAt ?? "", overrides: {} };
    this.players = (Array.isArray(b.players) ? b.players : []).map((p) => ({
      memberId: p.memberId ?? null,
      name: String(p.name ?? "Player"),
      division: p.division ?? null,
      startingHole: p.startingHole ?? null,
      scores: {},
    }));
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private findPlayer(b: ScoreBody): PlayerState | undefined {
    if (b.memberId) return this.players.find((p) => p.memberId === b.memberId);
    if (typeof b.index === "number") return this.players[b.index];
    if (b.name) return this.players.find((p) => p.name === b.name);
    return undefined;
  }

  private async score(b: ScoreBody): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    const hole = Number(b.hole);
    const strokes = Number(b.strokes);
    if (!this.meta.holes.some((h) => h.hole === hole)) return j({ error: "bad_hole" }, 400);
    if (!Number.isInteger(strokes) || strokes < 1 || strokes > 30) return j({ error: "bad_strokes" }, 400);
    const player = this.findPlayer(b);
    if (!player) return j({ error: "no_player" }, 404);
    player.scores[hole] = strokes;
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  // Round-scoped single-use override of a hole's par/distance. Admin-gated at the Worker. The layout
  // is never mutated, so the hole reverts to its verified value once this round ends.
  private async override(b: OverrideBody): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    const hole = Number(b.hole);
    if (!this.meta.holes.some((h) => h.hole === hole)) return j({ error: "bad_hole" }, 400);
    const overrides = this.meta.overrides ?? (this.meta.overrides = {});
    if (b.clear) {
      delete overrides[String(hole)];
    } else {
      const entry: { par?: number; distance_ft?: number } = {};
      const par = Number(b.par);
      const dist = Number(b.distance_ft);
      if (b.par != null && Number.isInteger(par) && par >= 1 && par <= 15) entry.par = par;
      if (b.distance_ft != null && Number.isFinite(dist) && dist >= 20 && dist <= 2000) entry.distance_ft = Math.round(dist);
      if (entry.par == null && entry.distance_ft == null) return j({ error: "empty_override" }, 400);
      overrides[String(hole)] = entry;
    }
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async finalize(): Promise<Response> {
    if (!this.meta) return j({ error: "not_started" }, 409);
    const standings = finalizeStandings(this.resolvedHoles(), this.players);
    // Idempotent: clear any prior results for this event, then write fresh (inserts run concurrently).
    await db.clearResults(this.env.DB, this.meta.eventId);
    const eventId = this.meta.eventId;
    await Promise.all(
      standings.map((s) =>
        db.createResult(this.env.DB, {
          event_id: eventId,
          member_id: s.memberId,
          name: s.name,
          place: s.place,
          total: s.total,
          to_par: s.toPar,
          breakdown: JSON.stringify(s.breakdown),
        }),
      ),
    );
    await db.updateEvent(this.env.DB, this.meta.eventId, { status: "final" });
    this.meta.status = "final";
    await this.persist();
    this.broadcast();
    return j({ status: "final", standings });
  }

  private handleWs(_request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    try { server.send(JSON.stringify({ type: "snapshot", ...this.snapshot() })); } catch { /* ignore */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(): void {
    const msg = JSON.stringify({ type: "snapshot", ...this.snapshot() });
    for (const ws of [...this.sockets]) {
      try { ws.send(msg); } catch { this.sockets.delete(ws); }
    }
  }
}
