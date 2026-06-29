import type { Env } from "./env.js";
import { secretOk } from "./authz.js";
import { allowedOrigin, corsHeaders, json, RequestBodyTooLargeError } from "./http.js";
import {
  handleBoard,
  handleLogin,
  handleMe,
  handleMyRegistrations,
  handleMyResults,
  handleProfile,
  handleSetPin,
} from "./member-routes.js";
import { handleAssistant } from "./assistant-route.js";
import { handleWebAuthnRoute } from "./webauthn-routes.js";
import { handleMyTeeSigns, handleTeeSignUpload } from "./tee-sign-routes.js";
import { clubApi } from "./club-api.js";
import { D1KV } from "./d1kv.js";

export type { Env } from "./env.js";
export { LiveEventDO } from "./live.js";

/**
 * STOPGAP: when no Workers KV namespace is bound (deployed dev/staging while this account's KV data
 * plane is degraded), back the ROSTER + RATELIMIT bindings with D1 instead. Tests inject KV mocks and
 * production binds real KV, so in those cases env is returned untouched and the adapter is bypassed.
 */
function withKvFallback(env: Env): Env {
  const cur = env as unknown as { ROSTER?: KVNamespace; RATELIMIT?: KVNamespace; DB: D1Database };
  if (cur.ROSTER || cur.RATELIMIT) return env; // real KV (prod) or mocks (tests) present — use as-is
  return {
    ...env,
    ROSTER: new D1KV(cur.DB, "roster") as unknown as KVNamespace,
    RATELIMIT: new D1KV(cur.DB, "ratelimit") as unknown as KVNamespace,
  } as Env;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    env = withKvFallback(env);
    const origin = allowedOrigin(env, request);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!secretOk(env)) return json({ error: "server_misconfigured" }, 500, origin);

    try {
      if (pathname === "/login" && method === "POST") return await handleLogin(request, env, origin);
      if (pathname === "/me" && method === "GET") return await handleMe(request, env, origin);
      if (pathname === "/my-results" && method === "GET") return await handleMyResults(request, env, origin);
      if (pathname === "/board" || pathname.startsWith("/board/")) return await handleBoard(request, env, origin);
      if (pathname === "/my-registrations" && method === "GET") return await handleMyRegistrations(request, env, origin);
      if (pathname === "/set-pin" && method === "POST") return await handleSetPin(request, env, origin);
      if (pathname === "/profile" && method === "POST") return await handleProfile(request, env, origin);
      if (pathname === "/assistant" && method === "POST") return await handleAssistant(request, env, origin);

      const webAuthn = await handleWebAuthnRoute(request, env, origin, pathname, method);
      if (webAuthn) return webAuthn;

      if (pathname === "/tee-signs" && method === "POST") return await handleTeeSignUpload(request, env, origin, ctx);
      if (pathname === "/my-tee-signs" && method === "GET") return await handleMyTeeSigns(request, env, origin);

      const club = await clubApi(request, env, origin, pathname, method);
      if (club) return club;

      return json({ error: "not_found" }, 404, origin);
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return json({ error: "request_too_large" }, 413, origin);
      console.error(JSON.stringify({ message: "worker_error", method, pathname, error: e instanceof Error ? e.stack : String(e) }));
      return json({ error: "server_error" }, 500, origin);
    }
  },
} satisfies ExportedHandler<Env>;
