import type { D1Like } from "./db.js";
import { AMENITIES, CONDITIONS, DIFFICULTIES, oneOf, type Amenity, type Amenities, type Condition, type Difficulty, type MetadataInput, type ModerationAction, type ReportReason, type ReviewInput } from "./community-input.js";

const unknownAmenities = Object.fromEntries(AMENITIES.map((key) => [key, "unknown"])) as Amenities;

interface CourseRow {
  id: number; name: string; location: string | null; difficulty: Difficulty | null; amenities: string | null;
  notes: string | null; updatedAt: string | null; revision: number | null; reviewCount: number; averageRating: number | null;
}

interface CourseFilters {
  query: string; difficulty: Difficulty | null; amenities: Partial<Record<Amenity, Condition>>; offset: number; favoriteMember?: string;
}

const COURSE_SELECT = `
  SELECT c.id, c.name, c.location, m.difficulty, m.amenities, m.notes, m.updated_at AS updatedAt, m.revision,
    (SELECT count(*) FROM community_course_reviews r WHERE r.course_id = c.id AND r.state = 'published') AS reviewCount,
    (SELECT round(avg(r.rating), 1) FROM community_course_reviews r WHERE r.course_id = c.id AND r.state = 'published') AS averageRating
  FROM courses c LEFT JOIN community_course_metadata m ON m.course_id = c.id
`;

function courseView(row: CourseRow) {
  let stored: Record<string, unknown> = {};
  if (row.amenities) { try { stored = JSON.parse(row.amenities); } catch { /* unknown until staff confirms */ } }
  const amenities = { ...unknownAmenities };
  for (const key of AMENITIES) amenities[key] = oneOf(stored?.[key], CONDITIONS) || "unknown";
  return {
    id: row.id, name: row.name, location: row.location, difficulty: row.difficulty || "unknown",
    amenities, notes: row.notes || "", updatedAt: row.updatedAt, revision: row.revision || 0,
    reviewCount: row.reviewCount || 0, averageRating: row.averageRating,
  };
}

export async function findCommunityCourses(db: D1Like, filters: CourseFilters) {
  const conditions = ["(? = '' OR instr(lower(c.name || ' ' || coalesce(c.location, '')), lower(?)) > 0)"];
  const values: unknown[] = [filters.query, filters.query];
  if (filters.difficulty) {
    conditions.push("coalesce(m.difficulty, 'unknown') = ?");
    values.push(filters.difficulty);
  }
  for (const key of AMENITIES) {
    if (!filters.amenities[key]) continue;
    conditions.push("coalesce(json_extract(m.amenities, ?), 'unknown') = ?");
    values.push("$." + key, filters.amenities[key]);
  }
  if (filters.favoriteMember) {
    conditions.push("EXISTS (SELECT 1 FROM member_course_favorites f WHERE f.course_id = c.id AND f.member_id = ?)");
    values.push(filters.favoriteMember);
  }
  const { results } = await db.prepare(COURSE_SELECT + " WHERE " + conditions.join(" AND ") +
    " ORDER BY LOWER(c.name), c.id LIMIT 26 OFFSET ?").bind(...values, filters.offset).all<CourseRow>();
  return { courses: results.slice(0, 25).map(courseView), more: results.length > 25 };
}

export async function readCommunityCourse(db: D1Like, id: number) {
  const row = await db.prepare(COURSE_SELECT + " WHERE c.id = ?").bind(id).first<CourseRow>();
  return row ? courseView(row) : null;
}

export async function saveCommunityMetadata(db: D1Like, course: number, input: MetadataInput) {
  const data = JSON.stringify(input.amenities);
  const current = await readCommunityCourse(db, course);
  if (!current) return { error: "course_not_found" } as const;

  const result = input.revision === 0 ? await db.prepare(`
    INSERT INTO community_course_metadata(course_id, difficulty, amenities, notes) VALUES (?, ?, ?, ?)
    ON CONFLICT(course_id) DO NOTHING`).bind(course, input.difficulty, data, input.notes).run()
    : await db.prepare(`
      UPDATE community_course_metadata SET difficulty = ?, amenities = ?, notes = ?, updated_at = datetime('now'),
        revision = revision + 1 WHERE course_id = ? AND revision = ?`)
      .bind(input.difficulty, data, input.notes, course, input.revision).run();
  const saved = await readCommunityCourse(db, course);
  if (saved && (result.meta?.changes || (saved.revision === input.revision + 1 && saved.difficulty === input.difficulty
    && saved.notes === input.notes && JSON.stringify(saved.amenities) === data))) return { course: saved };
  return { error: "course_changed" } as const;
}

type ReviewState = "pending" | "published" | "hidden" | "removed";
interface ReviewRow {
  id: number; rating: number | null; text: string; state: ReviewState; revision: number;
  createdAt: string; updatedAt: string; publishedAt: string | null;
}

const REVIEW_FIELDS = `r.id, r.rating, r.review_text AS text, r.state, r.revision, r.created_at AS createdAt,
  r.updated_at AS updatedAt, r.published_at AS publishedAt`;

export async function communityReviews(db: D1Like, course: number, viewer: string | null, offset: number) {
  const [rows, owned] = await Promise.all([
    db.prepare(`
      SELECT ${REVIEW_FIELDS}, CASE WHEN r.member_id = ? THEN 1 ELSE 0 END AS own,
        EXISTS (SELECT 1 FROM community_review_reports f WHERE f.review_id = r.id AND f.revision = r.revision AND f.reporter = ?) AS reported
      FROM community_course_reviews r WHERE r.course_id = ? AND r.state = 'published'
      ORDER BY r.published_at DESC, r.id DESC LIMIT 21 OFFSET ?`)
      .bind(viewer, viewer, course, offset).all<ReviewRow & { own: number; reported: number }>(),
    viewer ? memberReview(db, course, viewer) : Promise.resolve(null),
  ]);
  return {
    reviews: rows.results.slice(0, 20).map(({ id, rating, text, publishedAt, revision, own, reported }) => ({
      id, rating, text, publishedAt, revision, own: Boolean(own), reported: Boolean(reported),
    })),
    mine: owned,
    more: rows.results.length > 20,
  };
}

function memberReview(db: D1Like, course: number, actor: string) {
  return db.prepare("SELECT " + REVIEW_FIELDS + " FROM community_course_reviews r WHERE r.course_id = ? AND r.member_id = ?")
    .bind(course, actor).first<ReviewRow>();
}

export async function saveCommunityReview(db: D1Like, course: number, actor: string, review: ReviewInput) {
  if (!await db.prepare("SELECT 1 FROM courses WHERE id = ?").bind(course).first()) return { error: "course_not_found" } as const;
  const result = review.revision === 0 ? await db.prepare(`
    INSERT INTO community_course_reviews(course_id, member_id, rating, review_text, state)
      SELECT ?, ?, ?, ?, 'pending'
      WHERE (SELECT count(*) FROM community_course_reviews WHERE member_id = ? AND state != 'removed') < 200
      ON CONFLICT(course_id, member_id) DO NOTHING`)
      .bind(course, actor, review.rating, review.text, actor).run()
    : await db.prepare(`
      UPDATE community_course_reviews SET rating = ?, review_text = ?, state = 'pending', published_at = NULL,
          updated_at = datetime('now'), revision = revision + 1
      WHERE course_id = ? AND member_id = ? AND revision = ?
      AND (state != 'removed' OR (SELECT count(*) FROM community_course_reviews WHERE member_id = ? AND state != 'removed') < 200)`)
      .bind(review.rating, review.text, course, actor, review.revision, actor).run();
  const mine = await memberReview(db, course, actor);
  if (mine && (result.meta?.changes || (mine.revision === review.revision + 1 && mine.rating === review.rating
    && mine.text === review.text && mine.state !== "removed"))) return { mine };
  return { error: mine ? "review_changed" : "review_limit" } as const;
}

export async function removeCommunityReview(db: D1Like, course: number, actor: string, revision: number) {
  const result = await db.prepare(`
    UPDATE community_course_reviews SET state = 'removed', rating = NULL, review_text = '', published_at = NULL,
      revision = revision + 1, updated_at = datetime('now')
    WHERE course_id = ? AND member_id = ? AND revision = ? AND state != 'removed'`)
    .bind(course, actor, revision).run();
  const mine = await memberReview(db, course, actor);
  return Boolean(result.meta?.changes || mine?.state === "removed" || !mine);
}

export async function reportCommunityReview(db: D1Like, reviewId: number, revision: number, actor: string, reason: ReportReason) {
  const result = await db.prepare(`
    INSERT INTO community_review_reports(review_id, revision, reporter, reason)
    SELECT r.id, r.revision, ?, ? FROM community_course_reviews r WHERE r.id = ? AND r.revision = ?
      AND r.state = 'published' AND r.member_id != ?
    ON CONFLICT(review_id, revision, reporter) DO NOTHING`).bind(actor, reason, reviewId, revision, actor).run();
  const match = await db.prepare("SELECT 1 FROM community_review_reports WHERE review_id = ? AND revision = ? AND reporter = ?")
    .bind(reviewId, revision, actor).first();
  return Boolean(result.meta?.changes || match);
}

export async function moderationQueue(db: D1Like, offset: number) {
  const { results } = await db.prepare(`
    SELECT ${REVIEW_FIELDS}, c.id AS courseId, c.name AS courseName,
      (SELECT count(*) FROM community_review_reports f
        WHERE f.review_id = r.id AND f.revision = r.revision AND f.status = 'open') AS reportCount,
      (SELECT group_concat(DISTINCT f.reason) FROM community_review_reports f
        WHERE f.review_id = r.id AND f.revision = r.revision AND f.status = 'open') AS reasons
    FROM community_course_reviews r JOIN courses c ON c.id = r.course_id
    WHERE r.state = 'pending' OR (r.state = 'published' AND EXISTS (SELECT 1 FROM community_review_reports f
      WHERE f.review_id = r.id AND f.revision = r.revision AND f.status = 'open'))
    ORDER BY reportCount DESC, r.updated_at, r.id LIMIT 26 OFFSET ?`).bind(offset).all();
  return { queue: results.slice(0, 25), more: results.length > 25 };
}

export async function moderateCommunityReview(db: D1Like, reviewId: number, rev: number, action: ModerationAction) {
  if (!db.batch) throw new Error("community_batch_required");
  if (action === "approve") {
    await db.prepare(`
      UPDATE community_course_reviews SET state = 'published', published_at = datetime('now')
      WHERE id = ? AND revision = ? AND state = 'pending'`).bind(reviewId, rev).run();
  } else if (action === "hide") {
    await db.batch([
      db.prepare("UPDATE community_course_reviews SET state = 'hidden', published_at = NULL WHERE id = ? AND revision = ? AND state IN ('pending', 'published')").bind(reviewId, rev),
      db.prepare(`
        UPDATE community_review_reports SET status = 'resolved' WHERE review_id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM community_course_reviews r WHERE r.id = ? AND r.revision = ? AND r.state = 'hidden')`)
        .bind(reviewId, rev, reviewId, rev),
    ]);
  } else {
    await db.prepare(`
      UPDATE community_review_reports SET status = 'resolved' WHERE review_id = ? AND revision = ?
        AND EXISTS (SELECT 1 FROM community_course_reviews r WHERE r.id = ? AND r.revision = ? AND r.state = 'published')`)
      .bind(reviewId, rev, reviewId, rev).run();
  }
  const current = await db.prepare("SELECT state, revision FROM community_course_reviews WHERE id = ?").bind(reviewId).first<{ state: ReviewState; revision: number }>();
  return current?.revision === rev && (action === "hide" ? current.state === "hidden" : current.state === "published");
}

export function courseDifficulty(input: string | null) { return oneOf(input, DIFFICULTIES); }
