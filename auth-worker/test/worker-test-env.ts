import type { RawEnv } from "../src/env.js";
import type { KVLike } from "../src/ratelimit.js";
import type { KVListLike } from "../src/roster.js";

type WorkerEnvOptions = {
  readonly roster: KVListLike;
  readonly ratelimit?: KVLike;
  readonly db: D1Database;
  readonly secret: string;
  readonly origin: string;
};

type StatementHandlers = {
  readonly bind?: (values: readonly unknown[]) => void;
  readonly all?: () => readonly Record<string, unknown>[];
  readonly first?: () => Record<string, unknown> | null;
  readonly run?: () => { readonly changes?: number; readonly rowsWritten?: number } | void;
};

function unusedBinding(name: string): never {
  throw new Error(`unexpected_${name}_binding_access`);
}

function d1Meta(): D1Meta & Record<string, unknown> {
  return { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 };
}

function d1Result<T>(results: readonly T[] = []): D1Result<T> {
  return { results: [...results], success: true, meta: d1Meta() };
}

class TestD1Statement implements D1PreparedStatement {
  constructor(private readonly handlers: StatementHandlers) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.handlers.bind?.(values);
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result(this.handlers.all?.().map((row) => row as T) ?? []);
  }

  async first<T = unknown>(_colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.handlers.first?.() ?? null;
    return row as T | null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.handlers.run?.();
    const meta = d1Meta();
    if (result?.changes != null) meta.changes = result.changes;
    if (result?.rowsWritten != null) meta.rows_written = result.rowsWritten;
    return { results: [], success: true, meta };
  }

  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    return options?.columnNames === true ? [[]] : [];
  }
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

export function memoryKv(initial: Record<string, string> = {}): KVListLike {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
    list: async (opts) => {
      const prefix = opts?.prefix ?? "";
      return { keys: [...rows.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

export function d1Statement(handlers: StatementHandlers = {}): D1PreparedStatement {
  return new TestD1Statement(handlers);
}

export function d1Database(prepare: (sql: string) => D1PreparedStatement): D1Database {
  return {
    prepare,
    batch: async <T = unknown>() => [],
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => unusedBinding("DB.withSession"),
    dump: async () => new ArrayBuffer(0),
  };
}

export function workerEnv(options: WorkerEnvOptions): RawEnv {
  return {
    ROSTER: options.roster,
    RATELIMIT: options.ratelimit ?? memoryKv(),
    PHOTOS: unusedPhotos,
    DB: options.db,
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
    EXPECTED_ORIGIN: options.origin,
    GEMINI_VISION_MODEL: "",
    OPENROUTER_VISION_MODEL: "",
    VISION_MODEL: "",
    JWT_SECRET: options.secret,
    GEMINI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    PAYPAL_CLIENT_ID: "",
    PAYPAL_SECRET: "",
    VISION_DEV_STUB: "",
    ALLOWED_ORIGINS: options.origin,
    PAYPAL_API_BASE: "",
    LIVE: unusedLive,
    ASSISTANT_RL: unusedAssistantRateLimit,
  };
}
