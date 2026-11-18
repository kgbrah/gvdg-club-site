import type { Env, RawEnv } from "./env.js";
import { secretOk } from "./authz.js";
import { allowedOrigin, corsHeaders, json, RequestBodyTooLargeError } from "./http.js";
import {
  handleLogin,
  handleMe,
  handleWelcomeSeen,
  handleMyLiveRounds,
  handleMyRatings,
  handleMyRegistrations,
  handleMyResults,
  handlePlayStats,
  handleProfile,
  handleSetPin,
} from "./member-routes.js";
import { handleBoard } from "./member-board-routes.js";
import { handleDashboardTheme } from "./dashboard-theme-routes.js";
import { handleDiscColor } from "./disc-color-routes.js";
import { handleAssistant } from "./assistant-route.js";
import { handleWebAuthnRoute } from "./webauthn-routes.js";
import { handleMyTeeSigns, handleTeeSignUpload } from "./tee-sign-routes.js";
import { handlePdgaStats } from "./pdga.js";
import { handleClubFeed } from "./feeds.js";
import { handleMembershipApply } from "./membership-apply.js";
import { handleMembershipPublic } from "./membership-dues.js";
import { clubApi } from "./club-api.js";
import { D1KV } from "./d1kv.js";

export type { Env } from "./env.js";
export { LiveEventDO } from "./live.js";

import { runRatingsRecompute } from "./ratings-recompute.js";
import { isPdgaEventCron, refreshClubPdgaEvents } from "./pdga-events.js";
import { handlePdgaBaselines, isPdgaBaselineRoute } from "./pdga-baseline-routes.js";
import { runPdgaBaselineTick } from "./pdga-baseline-ingest.js";
import { isUdiscLayoutCron, runUdiscLayoutImportTick } from "./udisc-layout-import.js";
import { handleMemberPush } from "./member-push.js";
import { handleMemberMessages } from "./member-messages.js";
import { isUdiscLeagueRefreshCron, refreshImportedUdiscLeagues } from "./udisc-league-refresh.js";
import { handleUdiscHistory } from "./udisc-history-routes.js";
import { handleMyPlayHistory, handleMyPlayExport } from "./play-history-routes.js";
import { handleWatchRoute } from "./watch-routes.js";
import { handleCourseFavorites } from "./course-favorite-routes.js";
import { handlePracticeRoute } from "./practice-routes.js";
import { handleCourseHealth } from "./course-operator-routes.js";
import { handleCommunityRoute } from "./community-routes.js";
import { handleOfflineRoundRoute } from "./offline-round-routes.js";
import { handlePhoneActivityRoute } from "./phone-activity-routes.js";
import { handleMemberArchiveRoute } from "./member-archive-routes.js";
import { handleMarket } from "./market-routes.js";
import { finalizeWithdrawals } from "./market-sweep.js";
import { handleLostFound } from "./lf-routes.js";
import { runLostFoundTick } from "./lf-process.js";
import { sendMembershipRenewalReminders } from "./membership-renewal.js";

/**
 * STOPGAP: when no Workers KV namespace is bound (deployed dev/staging while this account's KV data
 * plane is degraded), back missing ROSTER + RATELIMIT bindings with D1 instead. Tests inject KV mocks and
 * production binds real KV, so those stores are preserved when present.
 */
function withKvFallback(env: RawEnv): Env {
  return {
    ...env,
    ROSTER: env.ROSTER ?? new D1KV(env.DB, "roster"),
    RATELIMIT: env.RATELIMIT ?? new D1KV(env.DB, "ratelimit"),
  };
}

export default {
  async fetch(request: Request, rawEnv: RawEnv, ctx?: ExecutionContext): Promise<Response> {
    const env = withKvFallback(rawEnv);
    const origin = allowedOrigin(env, request);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!secretOk(env)) return json({ error: "server_misconfigured" }, 500, origin);

    try {
      const watch = await handleWatchRoute(request, env, origin, pathname, method);
      if (watch) return watch;
      const practice = await handlePracticeRoute(request, env, origin, pathname, method);
      if (practice) return practice;
      const community = await handleCommunityRoute(request, env, origin, pathname, method);
      if (community) return community;
      const offline = await handleOfflineRoundRoute(request, env, origin, pathname, method);
      if (offline) return offline;
      const activity = await handlePhoneActivityRoute(request, env, origin, pathname, method);
      if (activity) return activity;
      const archive = await handleMemberArchiveRoute(request, env, origin, pathname, method);
      if (archive) return archive;
      if (pathname === "/admin/course-health" || pathname.startsWith("/admin/course-health/")) {
        return await handleCourseHealth(request, env, origin);
      }
      if (isPdgaBaselineRoute(pathname)) return await handlePdgaBaselines(request, env, origin);
      if (pathname === "/me/course-favorites" || /^\/me\/course-favorites\/\d+$/.test(pathname)) {
        return await handleCourseFavorites(request, env, origin);
      }
      if (pathname === "/login" && method === "POST") return await handleLogin(request, env, origin);
      if (pathname === "/me" && method === "GET") return await handleMe(request, env, origin);
      if (pathname === "/me/welcome-seen" && method === "POST") return await handleWelcomeSeen(request, env, origin);
      if (pathname === "/me/push-subscription" && (method === "GET" || method === "PUT" || method === "DELETE")) {
        return await handleMemberPush(request, env, origin, method);
      }
      const messages = await handleMemberMessages(request, env, origin, pathname, method, ctx);
      if (messages) return messages;
      if (pathname === "/my-results" && method === "GET") return await handleMyResults(request, env, origin);
      if (pathname === "/me/udisc-history" && (method === "GET" || method === "POST" || method === "DELETE")) {
        return await handleUdiscHistory(request, env, origin, method);
      }
      const udiscHistoryId = /^\/me\/udisc-history\/(\d+)$/.exec(pathname);
      if (udiscHistoryId && method === "DELETE") {
        return await handleUdiscHistory(request, env, origin, method, Number(udiscHistoryId[1]));
      }
      if (pathname === "/play-stats" && method === "GET") return await handlePlayStats(request, env, origin);
      if (pathname === "/my-play-history" && method === "GET") return await handleMyPlayHistory(request, env, origin);
      if (pathname === "/my-play-export" && method === "GET") return await handleMyPlayExport(request, env, origin);
      if (pathname === "/my-ratings" && method === "GET") return await handleMyRatings(request, env, origin);
      if (pathname === "/my-live-rounds" && method === "GET") return await handleMyLiveRounds(request, env, origin);
      if (pathname === "/board" || pathname.startsWith("/board/")) return await handleBoard(request, env, origin);
      if (pathname === "/my-registrations" && method === "GET") return await handleMyRegistrations(request, env, origin);
      if (pathname === "/set-pin" && method === "POST") return await handleSetPin(request, env, origin);
      if (pathname === "/profile" && method === "POST") return await handleProfile(request, env, origin);
      if (pathname === "/me/dashboard-theme") return await handleDashboardTheme(request, env, origin, method);
      if (pathname === "/me/disc-color") return await handleDiscColor(request, env, origin, method);
      if (pathname === "/assistant" && method === "POST") return await handleAssistant(request, env, origin);

      const webAuthn = await handleWebAuthnRoute(request, env, origin, pathname, method);
      if (webAuthn) return webAuthn;

      if (pathname === "/tee-signs" && method === "POST") return await handleTeeSignUpload(request, env, origin, ctx);
      if (pathname === "/my-tee-signs" && method === "GET") return await handleMyTeeSigns(request, env, origin);
      if (pathname === "/pdga-stats" && method === "GET") return await handlePdgaStats(request, env, origin);
      if (pathname === "/club-feed" && method === "GET") return await handleClubFeed(env, origin);
      if (pathname === "/membership/apply" && method === "POST") return await handleMembershipApply(request, env, origin, ctx);
      if (pathname.startsWith("/membership/")) {
        const membership = await handleMembershipPublic(request, env, origin, method, pathname.split("/").filter(Boolean));
        if (membership) return membership;
      }

      const market = await handleMarket(request, env, origin, pathname, method, ctx);
      if (market) return market;
      const lostFound = await handleLostFound(request, env, origin, pathname, method, ctx);
      if (lostFound) return lostFound;

      const club = await clubApi(request, env, origin, pathname, method, ctx);
      if (club) return club;

      return json({ error: "not_found" }, 404, origin);
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return json({ error: "request_too_large" }, 413, origin);
      console.error(JSON.stringify({ message: "worker_error", method, pathname, error: e instanceof Error ? e.stack : String(e) }));
      return json({ error: "server_error" }, 500, origin);
    }
  },
  // Daily ratings recompute (08:17 UTC), the 15-minute UDisc layout importer,
  // an hourly PDGA event refresh (plus the PDGA layout-baseline ingest tick), and a Sunday 3pm
  // Eastern UDisc league refresh.
  // Cron only — never reachable from the public fetch path.
  async scheduled(controller: ScheduledController, rawEnv: RawEnv, ctx: ExecutionContext): Promise<void> {
    const env = withKvFallback(rawEnv);
    ctx.waitUntil(
      (async () => {
        try {
          if (isUdiscLayoutCron(controller.cron)) {
            // Marketplace: make 24-hour-old withdrawals final and delete their photos. Isolated from the import.
            try {
              const sweep = await finalizeWithdrawals(env);
              if (sweep.finalized || sweep.photosDeleted) console.log(JSON.stringify({ message: "market_withdrawals_finalized", ...sweep }));
            } catch (error) {
              console.error(JSON.stringify({ message: "market_sweep_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            // Lost & Found: retry photos still waiting for a trusted AI read (with backoff), expire 90-day posts,
            // purge photos of finished posts. Isolated from the import.
            try {
              const lf = await runLostFoundTick(env);
              if (lf.photos || lf.expired || lf.purged) console.log(JSON.stringify({ message: "lost_found_tick", ...lf }));
            } catch (error) {
              console.error(JSON.stringify({ message: "lost_found_tick_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            const result = await runUdiscLayoutImportTick(env);
            console.log(JSON.stringify({ message: "udisc_layout_import_tick", cron: controller.cron, ...result }));
            return;
          }
          if (isPdgaEventCron(controller.cron)) {
            const result = await refreshClubPdgaEvents(env);
            console.log(JSON.stringify({ message: "pdga_events_refresh", cron: controller.cron, ...result }));
            // PDGA layout baselines: a few bounded pdga.com JSON reads per hour, isolated from the rest.
            try {
              const baselines = await runPdgaBaselineTick(env);
              console.log(JSON.stringify({ message: "pdga_baseline_tick", cron: controller.cron, ...baselines }));
            } catch (error) {
              console.error(JSON.stringify({ message: "pdga_baseline_tick_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            const leagues = await refreshImportedUdiscLeagues(env, new Date(controller.scheduledTime));
            if (!leagues.skipped) console.log(JSON.stringify({ message: "udisc_league_refresh", cron: controller.cron, ...leagues }));
            return;
          }
          if (isUdiscLeagueRefreshCron(controller.cron)) {
            const result = await refreshImportedUdiscLeagues(env, new Date(controller.scheduledTime));
            console.log(JSON.stringify({ message: "udisc_league_refresh", cron: controller.cron, ...result }));
            return;
          }
          const renewal = await sendMembershipRenewalReminders(env, new Date(controller.scheduledTime)).catch((error) => {
            console.error(JSON.stringify({
              message: "membership_renewal_reminder_failed",
              error: error instanceof Error ? error.stack : String(error),
            }));
            return null;
          });
          if (renewal && !renewal.skipped) {
            console.log(JSON.stringify({ message: "membership_renewal_reminder", ...renewal }));
          }
          const result = await runRatingsRecompute(env);
          console.log(JSON.stringify({ message: "ratings_recompute_complete", cron: controller.cron, ...result }));
        } catch (error) {
          console.error(JSON.stringify({
            message: isUdiscLayoutCron(controller.cron)
              ? "udisc_layout_import_failed"
              : isPdgaEventCron(controller.cron)
                ? "pdga_events_refresh_failed"
                : isUdiscLeagueRefreshCron(controller.cron)
                  ? "udisc_league_refresh_failed"
                  : "ratings_recompute_failed",
            cron: controller.cron,
            error: error instanceof Error ? error.stack : String(error),
          }));
          throw error;
        }
      })(),
    );
  },
} satisfies ExportedHandler<RawEnv>;
