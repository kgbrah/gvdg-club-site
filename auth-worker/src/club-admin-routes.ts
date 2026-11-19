import type { Env } from "./env.js";
import { adminGate } from "./authz.js";
import { json } from "./http.js";
import { asInt } from "./input.js";
import { handleAdminBagTags } from "./bag-tag-routes.js";
import { handleAdminPush } from "./admin-push.js";
import { handleAdminCourses } from "./club-admin-courses.js";
import { handleAdminEvents } from "./club-admin-events.js";
import { handleAdminFundraisers, handleAdminLeagues, handleAdminMeetings } from "./club-admin-content.js";
import { handleAdminLeagueNight } from "./league-night.js";
import { handleAdminImport } from "./club-admin-imports.js";
import { handleAdminLayouts } from "./club-admin-layouts.js";
import { handleAdminMembers } from "./club-admin-members.js";
import { handleAdminExport } from "./club-admin-export.js";
import { handleAdminShop } from "./club-admin-shop.js";
import { handleAdminTeeSigns } from "./club-admin-tee-signs.js";
import { handleAdminVoiceFill } from "./voice-fill-route.js";
import { handleSheetImport } from "./sheet-import.js";
import { handleTournamentAdmin } from "./tournament-routes.js";
import { handleAdminPdgaPromo } from "./pdga-membership-routes.js";

export async function handleClubAdmin(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  ctx?: ExecutionContext,
): Promise<Response | null> {
  if (seg[0] !== "admin") return null;
  const gate = await adminGate(request, env, origin);
  if (gate instanceof Response) return gate;

  const adminId = gate.adminId;
  const sub = seg[1];
  const id = seg[2] != null ? asInt(seg[2]) : null;
  let response: Response | null = null;

  if (sub === "courses") response = await handleAdminCourses(request, env, origin, method, seg, adminId, id);
  else if (sub === "bag-tags") response = await handleAdminBagTags(request, env, origin, method, seg, adminId, ctx);
  else if ((sub === "events" && (seg[3] === "tournament" || seg[3] === "pdga" || seg[3] === "pdga-results" || (seg[3] === "registrations" && (seg[5] === "zelle-received" || seg[5] === "offer"))))
    || sub === "pdga-events") response = await handleTournamentAdmin(request, env, origin, method, seg);
  else if (sub === "club-settings" && seg[2] === "pdga-promo") response = await handleAdminPdgaPromo(request, env, origin, method, adminId);
  else if (sub === "events") response = await handleAdminEvents(request, env, origin, method, seg, adminId, id);
  else if (sub === "leagues" && method === "POST" && seg[3] === "nights" && id != null) response = await handleAdminLeagueNight(request, env, origin, adminId, id);
  else if (sub === "leagues") response = await handleAdminLeagues(request, env, origin, method, adminId, id);
  else if (sub === "fundraisers") response = await handleAdminFundraisers(request, env, origin, method, adminId, id);
  else if (sub === "meetings") response = await handleAdminMeetings(request, env, origin, method, adminId, id);
  else if (sub === "import" && method === "POST") response = await handleAdminImport(request, env, origin, adminId);
  else if (sub === "layouts") response = await handleAdminLayouts(request, env, origin, method, id);
  else if (sub === "members") response = await handleAdminMembers(request, env, origin, method, seg, adminId, ctx);
  else if (sub === "sheet-import") response = await handleSheetImport(request, env, origin, method, seg, adminId);
  else if (sub === "shop" || sub === "wallets" || sub === "orders") response = await handleAdminShop(request, env, origin, method, seg, adminId);
  else if (sub === "tee-signs") response = await handleAdminTeeSigns(request, env, origin, method, seg, adminId, id);
  else if (sub === "voice-fill" && method === "POST") response = await handleAdminVoiceFill(request, env, origin, adminId);
  else if (sub === "export") response = await handleAdminExport(request, env, origin, method, seg, adminId);
  else if (sub === "push") response = await handleAdminPush(request, env, origin, method, seg, adminId);

  return response ?? json({ error: "not_found" }, 404, origin);
}
