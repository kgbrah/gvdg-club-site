import type { Env } from "./env.js";
import { handleClubAdmin } from "./club-admin-routes.js";
import { handleClubLive } from "./club-live-routes.js";
import { handleClubPublic } from "./club-public-routes.js";
import { handleClubRegistration } from "./club-registration-routes.js";
import { handleClubShop } from "./club-shop-routes.js";

export async function clubApi(request: Request, env: Env, origin: string | null, pathname: string, method: string): Promise<Response | null> {
  const seg = pathname.split("/").filter(Boolean);

  const publicRoute = await handleClubPublic(request, env, origin, pathname, method, seg);
  if (publicRoute) return publicRoute;

  const liveRoute = await handleClubLive(request, env, origin, method, seg);
  if (liveRoute) return liveRoute;

  const shopRoute = await handleClubShop(request, env, origin, method, seg);
  if (shopRoute) return shopRoute;

  const registrationRoute = await handleClubRegistration(request, env, origin, method, seg);
  if (registrationRoute) return registrationRoute;

  return handleClubAdmin(request, env, origin, method, seg);
}
