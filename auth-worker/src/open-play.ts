import type { Env } from "./env.js";
import { OPEN_PLAY_PREFIX, isOpenPlayId } from "./authz.js";
import { bearer, clientIp, json, readJson } from "./http.js";
import { asStr } from "./input.js";
import { signOpenPlaySession, verifySession } from "./jwt.js";
import { kvRateLimited } from "./kv-rate-limit.js";

export { OPEN_PLAY_PREFIX, isOpenPlayId };

/** Long enough for a day round; not a club login. */
export const OPEN_PLAY_TTL_SEC = 12 * 60 * 60;
const OPEN_PLAY_IP_LIMIT = 10;

function newOpenPlayId(): string {
  return OPEN_PLAY_PREFIX + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST /rounds/open-play — mint (or refresh) a scoring identity that cannot hit member routes. */
export async function mintOpenPlaySession(request: Request, env: Env, origin: string | null): Promise<Response> {
  if (await kvRateLimited(env, "openplay:" + clientIp(request), OPEN_PLAY_IP_LIMIT, 3600)) {
    return json({ error: "rate_limited" }, 429, origin);
  }
  const body = (await readJson(request)) ?? {};
  const name = asStr(body.name, 60);
  if (!name) return json({ error: "name_required" }, 400, origin);

  const existing = bearer(request) ? await verifySession(bearer(request)!, env.JWT_SECRET) : null;
  const sub = existing?.play && isOpenPlayId(existing.sub) ? existing.sub : newOpenPlayId();
  const token = await signOpenPlaySession({ sub, name }, env.JWT_SECRET, OPEN_PLAY_TTL_SEC);
  return json({ token, playerId: sub, name }, 200, origin);
}
