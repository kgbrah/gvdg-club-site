import worker from "../src/index.js";
import type { RawEnv } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import type { KVListLike } from "../src/roster.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const MEMBERS = {
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
};

export type DbState = {
  layoutBinds?: unknown[];
  eventBinds?: unknown[];
  updateEventBinds?: unknown[];
  registrationUpdateBinds?: unknown[];
  playerBinds?: unknown[];
  eventRow?: Record<string, unknown> | null;
  eventConfigRow?: Record<string, unknown> | null;
  acePotBinds?: unknown[];
  removedPlayer?: number;
  deleteEventId?: number;
  eventStatus?: string;
  eventDeleteBlockers?: Partial<Record<"event_config" | "registrations" | "event_players" | "results" | "ctps" | "wallet_transactions" | "ace_pots", number>>;
};

function unusedBinding(name: string): never {
  throw new Error(`unexpected_${name}_binding_access`);
}

function kv(initial: Record<string, string> = {}): KVListLike {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
    list: async (opts) => {
      const prefix = opts?.prefix ?? "";
      return {
        keys: [...rows.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

function d1Meta(): D1Meta & Record<string, unknown> {
  return { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 };
}

function d1Result<T>(results: T[] = []): D1Result<T> {
  return { results, success: true, meta: d1Meta() };
}

class AdminEventStatement implements D1PreparedStatement {
  private binds: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly state: DbState,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.binds = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (/FROM events e JOIN event_config c/i.test(this.sql)) {
      return d1Result<T>([
        {
          id: 5,
          name: "Summer Flex",
          date: "2026-07-12",
          type: "tournament",
          event_format: "stroke",
          course_id: 7,
          layout_id: 44,
          course_name: "West Meadowbrook",
          layout_name: "Gold",
          total_par: 54,
          entry_fee_cents: 1000,
          ctp_fee_cents: null,
          ace_fee_cents: null,
          divisions: "[]",
          play_format: "singles",
        } as T,
      ]);
    }
    return d1Result<T>();
  }

  async first<T = unknown>(_colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.firstRow();
    return row as T | null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (/DELETE FROM event_players/i.test(this.sql)) this.state.removedPlayer = Number(this.binds[0]);
    if (/DELETE FROM events/i.test(this.sql)) this.state.deleteEventId = Number(this.binds[0]);
    return d1Result<T>();
  }

  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    return options?.columnNames === true ? [[]] : [];
  }

  private firstRow(): Record<string, unknown> | null {
    if (/SELECT status FROM events WHERE id = \?/i.test(this.sql)) return { status: this.state.eventStatus ?? "scheduled" };
    if (/SELECT COUNT\(\*\) AS n FROM event_config WHERE event_id = \?/i.test(this.sql)) return { n: this.state.eventDeleteBlockers?.event_config ?? 0 };
    if (/SELECT COUNT\(\*\) AS n FROM registrations WHERE event_id = \?/i.test(this.sql)) return { n: this.state.eventDeleteBlockers?.registrations ?? 0 };
    if (/SELECT COUNT\(\*\) AS n FROM event_players WHERE event_id = \?/i.test(this.sql)) return { n: this.state.eventDeleteBlockers?.event_players ?? 0 };
    if (/SELECT COUNT\(\*\) AS n FROM results WHERE event_id = \?/i.test(this.sql)) return { n: this.state.eventDeleteBlockers?.results ?? 0 };
    if (/SELECT COUNT\(\*\) AS n FROM ctps WHERE event_id = \?/i.test(this.sql)) return { n: this.state.eventDeleteBlockers?.ctps ?? 0 };
    if (/SELECT COUNT\(\*\) AS n FROM wallet_transactions WHERE event_id = \?/i.test(this.sql)) return { n: this.state.eventDeleteBlockers?.wallet_transactions ?? 0 };
    if (/SELECT COUNT\(\*\) AS n FROM ace_pots WHERE event_id = \?/i.test(this.sql)) return { n: this.state.eventDeleteBlockers?.ace_pots ?? 0 };
    if (/SELECT \* FROM events WHERE id = \?/i.test(this.sql)) return this.state.eventRow === undefined ? null : this.state.eventRow;
    if (/SELECT \* FROM event_config WHERE event_id = \?/i.test(this.sql)) return this.state.eventConfigRow === undefined ? null : this.state.eventConfigRow;
    if (/INSERT INTO course_layouts/i.test(this.sql)) {
      this.state.layoutBinds = this.binds;
      return { id: 44, course_id: this.binds[0], name: this.binds[1], holes: this.binds[2], total_par: this.binds[3] };
    }
    if (/INSERT INTO events/i.test(this.sql)) {
      this.state.eventBinds = this.binds;
      return { id: 12, type: this.binds[0], name: this.binds[1], course_id: this.binds[5], layout_id: this.binds[6], created_by: this.binds[11] };
    }
    if (/INSERT INTO event_players/i.test(this.sql)) {
      this.state.playerBinds = this.binds;
      return { id: 88, event_id: this.binds[0], member_id: this.binds[1], name: this.binds[2], pdga_no: this.binds[3], division: this.binds[4], team: this.binds[5] };
    }
    if (/INSERT INTO ace_pots/i.test(this.sql)) {
      this.state.acePotBinds = this.binds;
      return {
        event_id: this.binds[0],
        carryover_in_cents: this.binds[1],
        status: this.binds[2],
        winner_member_id: this.binds[3],
        winner_name: this.binds[4],
        payout_cents: this.binds[5],
        resolved_at: this.binds[6],
      };
    }
    if (/UPDATE events/i.test(this.sql)) {
      this.state.updateEventBinds = this.binds;
      return { id: this.binds.at(-1), status: this.state.eventStatus ?? "scheduled" };
    }
    if (/UPDATE registrations SET/i.test(this.sql)) {
      this.state.registrationUpdateBinds = this.binds;
      return { id: this.binds.at(-2), event_id: this.binds.at(-1), starting_hole: this.binds[0], checked_in: this.binds[1] };
    }
    if (/SELECT \* FROM registrations WHERE id = \? AND event_id = \?/i.test(this.sql)) {
      this.state.registrationUpdateBinds = this.binds;
      return { id: this.binds[0], event_id: this.binds[1] };
    }
    return null;
  }
}

function db(state: DbState = {}): D1Database {
  return {
    prepare: (sql: string) => new AdminEventStatement(sql, state),
    batch: async <T = unknown>() => [],
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => unusedBinding("DB.withSession"),
    dump: async () => new ArrayBuffer(0),
  };
}

const unusedPhotos: R2Bucket = {
  head: () => unusedBinding("PHOTOS.head"),
  get: () => unusedBinding("PHOTOS.get"),
  put: () => unusedBinding("PHOTOS.put"),
  createMultipartUpload: () => unusedBinding("PHOTOS.createMultipartUpload"),
  resumeMultipartUpload: () => unusedBinding("PHOTOS.resumeMultipartUpload"),
  delete: () => unusedBinding("PHOTOS.delete"),
  list: () => unusedBinding("PHOTOS.list"),
};

const unusedAi: Ai = {
  aiGatewayLogId: null,
  gateway: () => unusedBinding("AI.gateway"),
  aiSearch: () => unusedBinding("AI.aiSearch"),
  autorag: () => unusedBinding("AI.autorag"),
  run: () => unusedBinding("AI.run"),
  models: () => unusedBinding("AI.models"),
  toMarkdown: () => unusedBinding("AI.toMarkdown"),
};

const unusedLive: RawEnv["LIVE"] = {
  newUniqueId: () => unusedBinding("LIVE.newUniqueId"),
  idFromName: () => unusedBinding("LIVE.idFromName"),
  idFromString: () => unusedBinding("LIVE.idFromString"),
  get: () => unusedBinding("LIVE.get"),
  getByName: () => unusedBinding("LIVE.getByName"),
  jurisdiction: () => unusedBinding("LIVE.jurisdiction"),
};

const unusedAssistantRateLimit: RateLimit = {
  limit: () => unusedBinding("ASSISTANT_RL.limit"),
};

function env(state: DbState = {}): RawEnv {
  return {
    ROSTER: kv(MEMBERS),
    RATELIMIT: kv(),
    PHOTOS: unusedPhotos,
    DB: db(state),
    AI: unusedAi,
    SESSION_TTL_SEC: "900",
    OPENROUTER_MODEL: "",
    OPENROUTER_FALLBACK_MODEL: "",
    ASSISTANT_MODEL: "",
    PAYPAL_ENV: "sandbox",
    ORDER_NOTIFY_EMAIL: "",
    ORDER_NOTIFY_FROM: "",
    REGISTER_NOTIFY_FROM: "",
    EMAIL_REPLY_TO: "",
    RP_ID: "",
    RP_NAME: "",
    EXPECTED_ORIGIN: ORIGIN,
    GEMINI_VISION_MODEL: "",
    OPENROUTER_VISION_MODEL: "",
    VISION_MODEL: "",
    JWT_SECRET: SECRET,
    GEMINI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    PAYPAL_CLIENT_ID: "",
    PAYPAL_SECRET: "",
    VISION_DEV_STUB: "",
    ALLOWED_ORIGINS: ORIGIN,
    PAYPAL_API_BASE: "",
    LIVE: unusedLive,
    ASSISTANT_RL: unusedAssistantRateLimit,
  };
}

export async function token(sub: string) {
  return signSession({ sub, mustChangePin: false }, SECRET, 900);
}

export async function call(path: string, method = "GET", body?: unknown, jwt?: string, state: DbState = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (jwt) headers.authorization = "Bearer " + jwt;
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env(state));
}
