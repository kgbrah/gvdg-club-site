export const COURSE_CONDITION_STATUSES = ["dry", "playable", "wet", "flooded", "closed"];

export const COURSE_CONDITION_LABELS = {
  dry: "Dry",
  playable: "Playable",
  wet: "Wet",
  flooded: "Flooded",
  closed: "Closed",
};

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

function parseCreatedAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return Date.parse(raw.replace(" ", "T") + "Z");
  }
  return Date.parse(raw);
}

export function normalizeCourseName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function conditionAgeMs(createdAt, now = Date.now()) {
  const time = parseCreatedAt(createdAt);
  return Number.isFinite(time) ? now - time : null;
}

export function isStaleCondition(createdAt, now = Date.now()) {
  const age = conditionAgeMs(createdAt, now);
  return age != null && age > STALE_AFTER_MS;
}

export function formatConditionWhen(createdAt, now = Date.now()) {
  const age = conditionAgeMs(createdAt, now);
  if (age == null) return "";
  if (age < 60 * 1000) return "just now";
  const minutes = Math.round(age / 60000);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 7) return days + "d ago";
  const date = new Date(parseCreatedAt(createdAt));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function normalizeCondition(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const status = String(raw.status || "").trim().toLowerCase();
  if (!COURSE_CONDITION_STATUSES.includes(status)) return null;
  const courseId = Number(raw.course_id ?? raw.courseId);
  return {
    courseId: Number.isInteger(courseId) ? courseId : null,
    courseName: typeof raw.course_name === "string" ? raw.course_name : typeof raw.courseName === "string" ? raw.courseName : "",
    createdAt: raw.created_at ?? raw.createdAt ?? "",
    id: raw.id == null ? "" : String(raw.id),
    label: COURSE_CONDITION_LABELS[status],
    memberName: typeof raw.member_name === "string" ? raw.member_name : typeof raw.memberName === "string" ? raw.memberName : "Member",
    note: typeof raw.note === "string" ? raw.note : "",
    status,
    when: formatConditionWhen(raw.created_at ?? raw.createdAt, now),
  };
}

function namesForCourse(course) {
  return [course?.course, course?.name, course?.course_name, course?.courseName]
    .map(normalizeCourseName)
    .filter(Boolean);
}

export function matchCourseCondition(course, reports) {
  const names = namesForCourse(course);
  const courseId = Number(course?.id ?? course?.courseId);
  let best = null;
  for (const report of Array.isArray(reports) ? reports : []) {
    const row = report && report.status ? report : normalizeCondition(report);
    if (!row) continue;
    const sameId = Number.isInteger(courseId) && courseId > 0 && row.courseId === courseId;
    const reportName = normalizeCourseName(row.courseName);
    const sameName = Boolean(reportName) && names.some((name) => name === reportName || name.includes(reportName) || reportName.includes(name));
    if (!sameId && !sameName) continue;
    if (!best || String(row.createdAt) > String(best.createdAt) || Number(row.id) > Number(best.id)) best = row;
  }
  return best;
}

export function latestConditionsByCourse(reports) {
  const list = (Array.isArray(reports) ? reports : []).map(normalizeCondition).filter(Boolean);
  const byKey = new Map();
  for (const report of list) {
    const key = report.courseId != null ? "id:" + report.courseId : "name:" + normalizeCourseName(report.courseName);
    const current = byKey.get(key);
    if (!current || Number(report.id) > Number(current.id)) byKey.set(key, report);
  }
  return [...byKey.values()].sort((a, b) => String(a.courseName).localeCompare(String(b.courseName)));
}
