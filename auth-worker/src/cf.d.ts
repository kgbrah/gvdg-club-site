// Minimal Cloudflare Workers runtime types we rely on (we intentionally don't depend on the full
// @cloudflare/workers-types package). Covers Durable Objects + the WebSocket upgrade extensions.
export {};

declare global {
  interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  }
  interface DurableObjectState {
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
  interface DurableObjectId {
    toString(): string;
  }
  interface DurableObjectStub {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  }
  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  // Cloudflare WebSocket extensions on top of the WebWorker lib's WebSocket.
  interface WebSocket {
    accept(): void;
  }
  const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };
  interface ResponseInit {
    webSocket?: WebSocket;
  }
}
