import type { KVLike } from "./ratelimit.js";

type RateLimitEnv = {
  readonly RATELIMIT: KVLike;
};

export async function kvRateLimited(env: RateLimitEnv, key: string, limit: number, windowSec: number): Promise<boolean> {
  const cur = parseInt((await env.RATELIMIT.get(key)) || "0", 10) || 0;
  if (cur >= limit) return true;
  await env.RATELIMIT.put(key, String(cur + 1), { expirationTtl: windowSec });
  return false;
}
