import type { Env } from "./env.js";
import { handleClubAdmin } from "./club-admin-routes.js";
import { handleCasualRoundRequests } from "./club-casual-round-requests-routes.js";
import { handleClubLive } from "./club-live-routes.js";
import { handleCasualRounds } from "./club-rounds-routes.js";
import { handleCourseConditions } from "./course-conditions-routes.js";
import { handleEventChat } from "./event-chat-routes.js";
import { handleHoleHeatmap } from "./hole-shot-marks-routes.js";
import { handleClubPublic } from "./club-public-routes.js";
import { handleClubRegistration } from "./club-registration-routes.js";
import { handleClubShop } from "./club-shop-routes.js";

export async function clubApi(request: Request, env: Env, origin: string | null, pathname: string, method: string, ctx?: ExecutionContext): Promise<Response | null> {
  const seg = pathname.split("/").filter(Boolean);

  const conditionsRoute = await handleCourseConditions(request, env, origin, pathname, method, seg);
  if (conditionsRoute) return conditionsRoute;

  const chatRoute = await handleEventChat(request, env, origin, method, seg);
  if (chatRoute) return chatRoute;

  const heatmapRoute = await handleHoleHeatmap(request, env, origin, method, seg);
  if (heatmapRoute) return heatmapRoute;

  const publicRoute = await handleClubPublic(request, env, origin, pathname, method, seg);
  if (publicRoute) return publicRoute;

  const liveRoute = await handleClubLive(request, env, origin, method, seg);
  if (liveRoute) return liveRoute;

  const casualRequestsRoute = await handleCasualRoundRequests(request, env, origin, method, seg);
  if (casualRequestsRoute) return casualRequestsRoute;

  const roundsRoute = await handleCasualRounds(request, env, origin, method, seg);
  if (roundsRoute) return roundsRoute;

  const shopRoute = await handleClubShop(request, env, origin, method, seg, ctx);
  if (shopRoute) return shopRoute;

  const registrationRoute = await handleClubRegistration(request, env, origin, method, seg, ctx);
  if (registrationRoute) return registrationRoute;

  return handleClubAdmin(request, env, origin, method, seg);
}
