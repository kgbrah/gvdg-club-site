import { karmaKey } from "./karma-directory.js";
import type { D1Like } from "./db.js";
import { communityRoundTotals } from "./community-progress.js";
import type { Audience, ConnectionAction, ProfileInput } from "./community-input.js";

interface ProfileRow {
  memberId: string;
  key: string;
  audience: Audience;
  displayName: string;
  bio: string;
  shareProgress: number;
  sharePdga: number;
  revision: number;
}

const PROFILE_FIELDS = `member_id AS memberId, profile_key AS key, audience, display_name AS displayName, bio,
  share_progress AS shareProgress, share_pdga AS sharePdga, revision`;

function mineView(row: ProfileRow | null) {
  if (!row) return { key: null, audience: "private", displayName: "", bio: "", shareProgress: false, sharePdga: false, revision: 0 };
  const { memberId: _member, ...profile } = row;
  return { ...profile, shareProgress: Boolean(profile.shareProgress), sharePdga: Boolean(profile.sharePdga) };
}

export function profileByKey(db: D1Like, key: string) {
  return db.prepare("SELECT " + PROFILE_FIELDS + " FROM community_profiles WHERE profile_key = ?").bind(key).first<ProfileRow>();
}

function profileByOwner(db: D1Like, owner: string) {
  return db.prepare("SELECT " + PROFILE_FIELDS + " FROM community_profiles WHERE member_id = ?").bind(owner).first<ProfileRow>();
}

export async function communityProfileSettings(db: D1Like, owner: string) { return mineView(await profileByOwner(db, owner)); }

export async function saveCommunityProfile(db: D1Like, owner: string, input: ProfileInput) {
  const share = Number(input.shareProgress);
  const sharePdga = Number(input.sharePdga);
  const result = input.revision === 0 ? await db.prepare(`
    INSERT INTO community_profiles(member_id, profile_key, audience, display_name, bio, share_progress, share_pdga)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(member_id) DO NOTHING`)
    .bind(owner, crypto.randomUUID(), input.audience, input.displayName, input.bio, share, sharePdga).run()
    : await db.prepare(`
    UPDATE community_profiles SET profile_key = CASE WHEN audience = 'public' AND ? != 'public' THEN ? ELSE profile_key END,
      audience = ?, display_name = ?, bio = ?, share_progress = ?, share_pdga = ?, revision = revision + 1,
      updated_at = datetime('now') WHERE member_id = ? AND revision = ?`)
      .bind(input.audience, crypto.randomUUID(), input.audience, input.displayName, input.bio, share, sharePdga, owner, input.revision).run();
  const row = await profileByOwner(db, owner);
  const current = mineView(row);
  if (!row) return null;
  if (result.meta?.changes || (row.audience === input.audience && row.displayName === input.displayName
    && row.bio === input.bio && row.shareProgress === share && row.sharePdga === sharePdga && row.revision === input.revision + 1)) return current;
  return null;
}

const BLOCKED = `EXISTS (SELECT 1 FROM community_blocks
  WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?))`;

async function isBlocked(db: D1Like, viewer: string, target: string) {
  const row = await db.prepare("SELECT " + BLOCKED + " AS blocked")
    .bind(viewer, target, target, viewer).first<{ blocked: number }>();
  return Boolean(row?.blocked);
}

function pair(a: string, b: string) { return a < b ? [a, b] : [b, a]; }

async function isFriend(db: D1Like, viewer: string, target: string) {
  return Boolean(await db.prepare("SELECT 1 FROM community_connections WHERE member_low = ? AND member_high = ? AND state = 'accepted'")
    .bind(...pair(viewer, target)).first());
}

export async function viewCommunityProfile(db: D1Like, row: ProfileRow, viewer: string | null, memberPdga: string | null = null) {
  const { memberId, key, audience, displayName, bio, shareProgress, sharePdga } = row;
  const self = viewer === memberId;
  if (!self) {
    if (audience === "private" || (audience !== "public" && !viewer)) return null;
    if (viewer && await isBlocked(db, viewer, memberId)) return null;
    if (audience === "friends" && (!viewer || !await isFriend(db, viewer, memberId))) return null;
  }
  const totals = shareProgress ? await communityRoundTotals(db, memberId) : null;
  const sharedPdga = sharePdga && memberPdga ? { pdgaNo: memberPdga } : {};
  return { key, audience, displayName, bio, progress: totals ? { total: totals.club + totals.casual } : null, ...sharedPdga };
}

interface DirectoryRow { memberId: string; key: string; displayName: string; audience: Audience }

export async function directoryProfiles(db: D1Like, viewer: string, query: string, offset: number) {
  const { results } = await db.prepare(`
    SELECT p.member_id AS memberId, p.profile_key AS key, p.display_name AS displayName, p.audience
    FROM community_profiles p WHERE p.member_id != ?
     AND (p.audience IN ('club', 'public') OR (p.audience = 'friends' AND EXISTS (
       SELECT 1 FROM community_connections r WHERE r.state = 'accepted'
       AND ((r.member_low = ? AND r.member_high = p.member_id) OR (r.member_high = ? AND r.member_low = p.member_id))
     )))
     AND NOT EXISTS (SELECT 1 FROM community_blocks b
       WHERE (b.blocker = ? AND b.blocked = p.member_id) OR (b.blocked = ? AND b.blocker = p.member_id))
     AND (? = '' OR instr(lower(p.display_name), lower(?)) > 0)
    ORDER BY lower(p.display_name), p.profile_key LIMIT 26 OFFSET ?`)
    .bind(viewer, viewer, viewer, viewer, viewer, query, query, offset).all<DirectoryRow>();
  return { results: results.slice(0, 25), more: results.length > 25 };
}

interface Contact { key: string; memberId: string; displayName: string; state: "pending" | "accepted"; requestedBy: string; audience: Audience }

export async function communityContacts(db: D1Like, owner: string) {
  const [related, blocked] = await Promise.all([
    db.prepare(`
      SELECT p.profile_key AS key, p.member_id AS memberId, p.display_name AS displayName, p.audience, r.state, r.requested_by AS requestedBy
      FROM community_connections r JOIN community_profiles p
        ON p.member_id = CASE WHEN r.member_low = ? THEN r.member_high ELSE r.member_low END
      WHERE r.member_low = ? OR r.member_high = ?
      ORDER BY r.state DESC, lower(p.display_name), p.profile_key LIMIT 251`)
      .bind(owner, owner, owner).all<Contact>(),
    db.prepare(`
      SELECT p.profile_key AS key, p.display_name AS displayName, p.audience
      FROM community_blocks b JOIN community_profiles p ON p.member_id = b.blocked
      WHERE b.blocker = ? ORDER BY lower(p.display_name), p.profile_key LIMIT 301`)
      .bind(owner).all<{ key: string; displayName: string; audience: Audience }>(),
  ]);
  return {
    contacts: related.results.map((row) => {
      const hidden = row.audience === "private" || (row.audience === "friends" && row.state !== "accepted" && row.requestedBy === owner);
      return {
        key: row.key,
        displayName: hidden ? "Member" : row.displayName,
        // Karma shows with the name, so only where the name itself is shown.
        karmaKey: hidden ? "" : karmaKey(row.memberId),
        relation: row.state === "accepted" ? "friend" : row.requestedBy === owner ? "outgoing" : "incoming",
      };
    }),
    blocked: blocked.results.map(({ key, audience, displayName }) => ({ key, displayName: audience === "club" || audience === "public" ? displayName : "Member" })),
  };
}

export async function updateCommunityConnection(db: D1Like, actor: string, target: ProfileRow, action: ConnectionAction) {
  const targetId = target.memberId;
  if (actor === targetId) return "invalid_target";
  const [low, high] = pair(actor, targetId);
  const remove = db.prepare("DELETE FROM community_connections WHERE member_low = ? AND member_high = ?").bind(low, high);

  if (action === "block") {
    if (!db.batch) throw new Error("community_batch_required");
    await db.batch([
      db.prepare(`
        INSERT INTO community_blocks(blocker, blocked) SELECT ?, ?
        WHERE (SELECT count(*) FROM community_blocks WHERE blocker = ?) < 300
        ON CONFLICT(blocker, blocked) DO NOTHING`).bind(actor, targetId, actor),
      db.prepare(`DELETE FROM community_connections WHERE member_low = ? AND member_high = ?
        AND EXISTS (SELECT 1 FROM community_blocks WHERE blocker = ? AND blocked = ?)`).bind(low, high, actor, targetId),
    ]);
    const block = await db.prepare("SELECT 1 FROM community_blocks WHERE blocker = ? AND blocked = ?").bind(actor, targetId).first();
    return block ? null : "connection_limit";
  }
  if (action === "unblock") {
    await db.prepare("DELETE FROM community_blocks WHERE blocker = ? AND blocked = ?").bind(actor, targetId).run();
    return null;
  }
  if (action === "remove") { await remove.run(); return null; }
  if (await isBlocked(db, actor, targetId)) return "connection_unavailable";

  if (action === "request") {
    await db.prepare(`
      INSERT INTO community_connections(member_low, member_high, requested_by, state)
      SELECT ?, ?, ?, 'pending'
      WHERE NOT ${BLOCKED}
        AND EXISTS (SELECT 1 FROM community_profiles WHERE member_id = ? AND audience != 'private')
        AND EXISTS (SELECT 1 FROM community_profiles WHERE member_id = ? AND audience IN ('club', 'public'))
        AND (SELECT count(*) FROM community_connections WHERE member_low = ? OR member_high = ?) < 250
        AND (SELECT count(*) FROM community_connections WHERE member_low = ? OR member_high = ?) < 250
      ON CONFLICT(member_low, member_high) DO NOTHING`)
      .bind(low, high, actor, actor, targetId, targetId, actor, actor, targetId, actor, actor, targetId, targetId).run();
  } else {
    await db.prepare(`
      UPDATE community_connections SET state = 'accepted' WHERE member_low = ? AND member_high = ?
        AND requested_by = ? AND state = 'pending' AND NOT ${BLOCKED}`)
      .bind(low, high, targetId, actor, targetId, targetId, actor).run();
  }
  const contact = await db.prepare("SELECT state FROM community_connections WHERE member_low = ? AND member_high = ?")
    .bind(low, high).first<{ state: string }>();
  return contact && (action === "request" || contact.state === "accepted") ? null : "connection_unavailable";
}
