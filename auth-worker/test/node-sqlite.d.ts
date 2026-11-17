declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
  export function readdirSync(path: URL | string): string[];
  export function writeFileSync(path: URL | string, data: string): void;
  export function existsSync(path: URL | string): boolean;
  export function mkdirSync(path: URL | string, options?: { recursive?: boolean }): void;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...args: unknown[]): Record<string, unknown>[];
      get(...args: unknown[]): Record<string, unknown> | undefined;
      run(...args: unknown[]): { changes: number };
    };
  }
}
