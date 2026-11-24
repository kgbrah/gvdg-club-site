import type { Env, RawEnv } from "./env.js";
import { handleMemberPhoto } from "./profile-photo.js";
import { handleEmailStart, handleEmailVerify, handlePinResetStart, handlePinResetVerify } from "./account-recovery.js";
import { historyGate, secretOk } from "./authz.js";
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
import { handlePdgaLiveEvent } from "./pdga-live-routes.js";
import { handlePdgaRegistrations, handlePdgaRegistrationStatus, refreshPdgaRegistrations } from "./pdga-registrations.js";
import { handleClubFeed } from "./feeds.js";
import { handleMembershipApply } from "./membership-apply.js";
import { handleMembershipPublic } from "./membership-dues.js";
import { clubApi } from "./club-api.js";
import { ConsistentKV, D1KV, purgeExpired, ROSTER_RECENT_NS } from "./d1kv.js";

export type { Env } from "./env.js";
export { LiveEventDO } from "./live.js";

import { runRatingsRecompute } from "./ratings-recompute.js";
import { isPdgaEventCron, refreshClubPdgaEvents } from "./pdga-events.js";
import { handleKarma } from "./karma-directory.js";
import { handleActiveRounds } from "./active-rounds.js";
import { handleGuestSpots } from "./guest-accounts.js";
import { runKarmaWatch } from "./karma-watch.js";
import { purgePdgaCaches } from "./pdga-api.js";
import { refreshClubPdgaEventCopies } from "./pdga-event-cache.js";
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
import { handleVoiceDisc } from "./voice-disc-route.js";
import { handleBag } from "./bag-routes.js";
import { handleMyDonations } from "./club-donations.js";
import { handleMemberWorkdays } from "./club-workdays.js";
import { handleMemberAnnouncements } from "./club-announcements.js";
import { runLostFoundTick } from "./lf-process.js";
import { sendMembershipRenewalReminders } from "./membership-renewal.js";
import { handlePdgaPlayerLookup } from "./tournament-routes.js";
import { handlePdgaMembership } from "./pdga-membership-routes.js";

/**
 * STOPGAP: when no Workers KV namespace is bound (deployed dev/staging while this account's KV data
 * plane is degraded), back missing ROSTER + RATELIMIT bindings with D1 instead. Tests inject KV mocks and
 * production binds real KV, so those stores are preserved when present.
 */
/** Sign-in counters (lockouts, rate limits, passkey challenges, emailed codes) live in D1 when RATELIMIT_BACKEND is
 *  "d1" (the deployed setting): Workers KV allows 1,000 writes a day on the free plan and every sign-in attempt
 *  writes a counter, so a busy day (a big Sheets import writes member records to KV too) could stop sign-in. D1
 *  allows 100,000 row writes a day and reads its own writes at once. Set it to "kv" to go back. */
export function limitsInD1(env: RawEnv): boolean {
  return String((env as { RATELIMIT_BACKEND?: unknown }).RATELIMIT_BACKEND ?? "").toLowerCase() === "d1";
}

function withKvFallback(env: RawEnv): Env {
  const roster = env.ROSTER
    ? (env.DB && !(env.ROSTER instanceof D1KV) ? new ConsistentKV(env.ROSTER, env.DB) : env.ROSTER)
    : new D1KV(env.DB, "roster");
  return {
    ...env,
    ROSTER: roster,
    RATELIMIT: limitsInD1(env) || !env.RATELIMIT ? new D1KV(env.DB, "ratelimit") : env.RATELIMIT,
  };
}

/** The site can serve this API at /api on its own address (a Worker route for gvdgclub.com/api/*): same-origin calls
 *  skip the CORS preflight and the second TLS connection a phone makes to auth.gvdgclub.com. The prefix is stripped,
 *  so every handler sees the same paths either way. */
export function withoutApiPrefix(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return request;
  url.pathname = url.pathname.slice(4) || "/";
  return new Request(url.toString(), request);
}

export default {
  async fetch(rawRequest: Request, rawEnv: RawEnv, ctx?: ExecutionContext): Promise<Response> {
    const request = withoutApiPrefix(rawRequest);
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
      if (pathname === "/me/course-favorites" || /^\/me\/course-favorites\/\d+$/.test(pathname)) {
        return await handleCourseFavorites(request, env, origin);
      }
      if (method === "GET" && pathname.startsWith("/member-photos/")) {
        const photo = await handleMemberPhoto(pathname, env);
        if (photo) return photo;
      }
      if (pathname === "/login" && method === "POST") return await handleLogin(request, env, origin);
      if (pathname === "/me" && method === "GET") return await handleMe(request, env, origin);
      if (pathname === "/me/welcome-seen" && method === "POST") return await handleWelcomeSeen(request, env, origin);
      if (pathname === "/me/email/start" && method === "POST") return await handleEmailStart(request, env, origin);
      if (pathname === "/me/email/verify" && method === "POST") return await handleEmailVerify(request, env, origin);
      if (pathname === "/pin-reset/start" && method === "POST") return await handlePinResetStart(request, env, origin, ctx);
      if (pathname === "/pin-reset/verify" && method === "POST") return await handlePinResetVerify(request, env, origin);
      if (pathname === "/me/push-subscription" && (method === "GET" || method === "PUT" || method === "DELETE")) {
        return await handleMemberPush(request, env, origin, method);
      }
      const messages = await handleMemberMessages(request, env, origin, pathname, method, ctx);
      if (messages) return messages;
      // Round history and stats: members, admins, and guests with a promo spot (guest-accounts.ts).
      if (
        ((pathname === "/my-results" || pathname === "/my-play-history" || pathname === "/my-play-export" || pathname === "/my-ratings" || pathname === "/play-stats") && method === "GET") ||
        (pathname === "/me/udisc-history" && (method === "GET" || method === "POST" || method === "DELETE")) ||
        (/^\/me\/udisc-history\/\d+$/.test(pathname) && method === "DELETE")
      ) {
        const blocked = await historyGate(request, env, origin);
        if (blocked) return blocked;
      }
      if (pathname === "/membership/guest-spots" && method === "GET") return await handleGuestSpots(env, origin);
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
      if (pathname === "/board" || pathname.startsWith("/board/")) return await handleBoard(request, env, origin, ctx);
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
      if (pathname === "/pdga-registrations" && method === "GET") return await handlePdgaRegistrations(request, env, origin);
      if (pathname === "/admin/pdga-registrations/status" && method === "GET") {
        return await handlePdgaRegistrationStatus(request, env, origin);
      }
      const pdgaLiveMatch = /^\/pdga\/live\/event\/([^/]+)$/.exec(pathname);
      if (pdgaLiveMatch && method === "GET") {
        return await handlePdgaLiveEvent(request, env, origin, pdgaLiveMatch[1]!);
      }
      if (pathname === "/pdga/player" && method === "GET") return await handlePdgaPlayerLookup(request, env, origin);
      if (pathname === "/pdga/membership" && method === "GET") return await handlePdgaMembership(request, env, origin);
      if (pathname === "/karma" && method === "GET") return await handleKarma(env, origin, request);
      if (pathname === "/admin/rounds/active" && method === "GET") return await handleActiveRounds(request, env, origin);
      if (pathname === "/club-feed" && method === "GET") return await handleClubFeed(env, origin);
      if (pathname === "/membership/apply" && method === "POST") return await handleMembershipApply(request, env, origin, ctx);
      if (pathname.startsWith("/membership/")) {
        const membership = await handleMembershipPublic(request, env, origin, method, pathname.split("/").filter(Boolean));
        if (membership) return membership;
      }

      if (pathname === "/voice/disc" && method === "POST") return await handleVoiceDisc(request, env, origin);
      if (pathname === "/me/donations") return await handleMyDonations(request, env, origin, method, ctx);
      const workdays = await handleMemberWorkdays(request, env, origin, pathname, method, ctx);
      if (workdays) return workdays;
      const announcements = await handleMemberAnnouncements(request, env, origin, pathname, method);
      if (announcements) return announcements;
      const bag = await handleBag(request, env, origin, pathname, method);
      if (bag) return bag;
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
  // an hourly PDGA event refresh, and a Sunday 3pm Eastern UDisc league refresh.
  // Cron only — never reachable from the public fetch path.
  async scheduled(controller: ScheduledController, rawEnv: RawEnv, ctx: ExecutionContext): Promise<void> {
    const env = withKvFallback(rawEnv);
    ctx.waitUntil(
      (async () => {
        try {
          if (isUdiscLayoutCron(controller.cron)) {
            // Sign-in counters and recent roster-consistency rows in D1 expire on read; clear expired rows nobody read again.
            try {
              const purged = await purgeExpired(env.DB, "ratelimit");
              const rosterPurged = await purgeExpired(env.DB, ROSTER_RECENT_NS);
              const peoplePurged = await purgeExpired(env.DB, "people_cache");
              if (purged || rosterPurged || peoplePurged) {
                console.log(JSON.stringify({ message: "kv_store_purged", ratelimit: purged, rosterRecent: rosterPurged, peopleCache: peoplePurged }));
              }
            } catch (error) {
              console.error(JSON.stringify({ message: "ratelimit_purge_failed", error: error instanceof Error ? error.message : String(error) }));
            }
            // Marketplace: make 24-hour-old withdrawals final and delete their photos. Isolated from the import.
            try {
              const sweep = await finalizeWithdrawals(env);
              if (sweep.finalized || sweep.photosDeleted) console.log(JSON.stringify({ message: "market_withdrawals_finalized", ...sweep }));
            } catch (error) {
              console.error(JSON.stringify({ message: "market_sweep_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            // Round karma watch: flag anyone past 3 finished rounds in a day for an admin (a few small reads).
            try {
              const watch = await runKarmaWatch(env, Date.now(), ctx);
              if (watch.flagged) console.log(JSON.stringify({ message: "karma_watch", ...watch }));
            } catch (error) {
              console.error(JSON.stringify({ message: "karma_watch_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            let importError: unknown = null;
            try {
              const result = await runUdiscLayoutImportTick(env);
              console.log(JSON.stringify({ message: "udisc_layout_import_tick", cron: controller.cron, ...result }));
            } catch (error) {
              importError = error;
            }
            // Lost & Found runs LAST in this branch, so however long its Gemini waits take it can never starve the
            // market sweep or the UDisc import above. It does I/O only (no image work); expiry and purges first.
            try {
              const lf = await runLostFoundTick(env);
              if (lf.expired || lf.purged || lf.reads || lf.matched) console.log(JSON.stringify({ message: "lost_found_tick", ...lf }));
            } catch (error) {
              console.error(JSON.stringify({ message: "lost_found_tick_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            if (importError) throw importError;
            return;
          }
          if (isPdgaEventCron(controller.cron)) {
            // PDGA's API license allows temporary caching only: drop PDGA data past its cache time, hourly.
            try {
              const purged = await purgePdgaCaches(env, Date.now());
              if (purged.players || purged.events || purged.playerStats) console.log(JSON.stringify({ message: "pdga_cache_purged", ...purged }));
            } catch (error) {
              console.error(JSON.stringify({ message: "pdga_cache_purge_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            try {
              const copies = await refreshClubPdgaEventCopies(env, Date.now());
              console.log(JSON.stringify({ message: "pdga_event_copies", ...copies }));
            } catch (error) {
              console.error(JSON.stringify({ message: "pdga_event_copies_failed", error: error instanceof Error ? error.stack : String(error) }));
            }
            let pdgaError: unknown = null;
            try {
              const result = await refreshClubPdgaEvents(env);
              console.log(JSON.stringify({ message: "pdga_events_refresh", cron: controller.cron, ...result }));
            } catch (error) {
              pdgaError = error;
              console.error(JSON.stringify({ message: "pdga_events_refresh_failed", cron: controller.cron, error: error instanceof Error ? error.stack : String(error) }));
            }
            try {
              const regResult = await refreshPdgaRegistrations(env, Date.now(), { skipPurge: true });
              console.log(JSON.stringify({ message: "pdga_registrations_refresh", cron: controller.cron, ...regResult }));
            } catch (error) {
              pdgaError = pdgaError ?? error;
              console.error(JSON.stringify({ message: "pdga_registrations_refresh_failed", cron: controller.cron, error: error instanceof Error ? error.stack : String(error) }));
            }
            let leagueError: unknown = null;
            try {
              const leagues = await refreshImportedUdiscLeagues(env, new Date(controller.scheduledTime));
              if (!leagues.skipped) console.log(JSON.stringify({ message: "udisc_league_refresh", cron: controller.cron, ...leagues }));
            } catch (error) {
              leagueError = error;
              console.error(JSON.stringify({ message: "udisc_league_refresh_failed", cron: controller.cron, error: error instanceof Error ? error.stack : String(error) }));
            }
            if (pdgaError || leagueError) throw pdgaError ?? leagueError;
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
