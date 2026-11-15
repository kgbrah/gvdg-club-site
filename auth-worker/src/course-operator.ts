import { COVERAGE_ORDER, layoutQuality, layoutRows, mapCoordinates, type Coverage } from "../../src/shared/course-quality.js";
import { escapePlayCsv } from "./play-history.js";

export const PRIORITIES = ["low", "normal", "high"] as const;
export const TASK_STATUSES = ["open", "in_progress", "completed"] as const;
export type TaskPriority = typeof PRIORITIES[number];
export type TaskStatus = typeof TASK_STATUSES[number];
export const TASK_PAGE_SIZE = 40;
export const STALE_DAYS = 365;
const DAY_MS = 86_400_000;

export type MaintenanceInput = {
  title: string; details: string; priority: TaskPriority; status: TaskStatus; dueDate: string | null;
};
export type TaskChange = { requestId: string; expectedRevision: number | null; input: MaintenanceInput };
export type OperatorWindow = { from: string; to: string };
export type MaintenanceTask = MaintenanceInput & {
  id: number; courseId: number; revision: number; createdAt: string; updatedAt: string;
};
export type CourseListing = { id: number; name: string; location: string | null };
type Raw = Record<string, unknown>;

export const COVERAGE_DEFINITION = "Layout coverage uses the current saved layouts and published map positions. Approval activity counts current layout holes linked to an official tee sign reviewed during the selected dates. Historical layout coverage and superseded approvals are unavailable.";

export const PARTICIPATION_DEFINITION = "Completed rounds count distinct finalized event records or casual cards with a ranked result on this course. Completed entries count each identified or individually recorded guest once per round. Unique identified players count member and open-play identities across the selected dates. Guests without a consistent identity are excluded from that count. An event with multiple assigned courses needs an as-played course on its scorecard. The filter uses the recorded event date and the UTC date of casual starts (or completion when no start was recorded).";

export function exactOperatorDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function operatorWindow(q: URLSearchParams, now = new Date()): OperatorWindow | null {
  const first = q.get("from");
  const last = q.get("to");
  if (first == null && last == null) return {
    from: new Date(now.getTime() - 29 * DAY_MS).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10),
  };
  const from = exactOperatorDate(first);
  const to = exactOperatorDate(last);
  return from && to && from <= to && (Date.parse(to) - Date.parse(from)) / DAY_MS <= 365 ? { from, to } : null;
}

export function positiveOperatorId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!/^[1-9]\d{0,15}$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function parseTaskChange(body: Raw | null, editing: boolean): TaskChange | null {
  if (!body || typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId)) return null;
  const accepted = ["requestId", "title", "details", "priority", "status", "dueDate", ...(editing ? ["expectedRevision"] : [])];
  if (Object.keys(body).some((field) => !accepted.includes(field))) return null;
  if (editing && ["title", "details", "priority", "status", "dueDate"].some((field) => !Object.hasOwn(body, field))) return null;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const details = body.details == null ? "" : typeof body.details === "string" ? body.details.trim() : null;
  const priority = body.priority ?? "normal";
  const status = body.status ?? "open";
  const date = body.dueDate == null || body.dueDate === "" ? null : exactOperatorDate(body.dueDate);
  const expectedRevision = editing ? positiveOperatorId(body.expectedRevision) : null;
  if (!title || title.length > 120 || details == null || details.length > 2_000 || /[\u0000-\u001f\u007f]/.test(title) ||
      details.includes("\u0000") || !PRIORITIES.includes(priority as TaskPriority) || !TASK_STATUSES.includes(status as TaskStatus) ||
      (body.dueDate != null && body.dueDate !== "" && !date) || (editing && !expectedRevision)) return null;
  return { requestId: body.requestId, expectedRevision, input: { title, details, priority: priority as TaskPriority, status: status as TaskStatus, dueDate: date } };
}

export async function taskFingerprint(taskId: number | null, change: TaskChange): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([taskId, change.expectedRevision, change.input]));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(raw: unknown): Raw {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Raw : {};
}

function latestTimestamp(values: unknown[]) {
  const timestamps = values.flatMap((value) => {
    if (typeof value !== "string" || !exactOperatorDate(value.slice(0, 10))) return [];
    const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? [date.toISOString()] : [];
  });
  return timestamps.sort().at(-1) ?? null;
}

type ReviewRow = { id: number; hole_number: number; reviewed_at: string | null; status: string };
type OperatorLayoutInput = Raw & { id: number; name: string | null };
type PublishedPosition = Raw & { layout_id: number; hole: number; kind: string };

export function operatorCoverage(layouts: OperatorLayoutInput[], published: PublishedPosition[], signs: ReviewRow[], window: OperatorWindow, now = new Date()) {
  const threshold = now.getTime() - STALE_DAYS * DAY_MS;
  const reviews = new Map(signs.filter((row) => row.status === "official").map((row) => [row.id, row]));
  let coverage: Coverage = "listed";
  let holes = 0;
  let mappedHoles = 0;
  let approvedPars = 0;
  let staleApprovalCount = 0;
  let approvalsReviewedInWindow = 0;
  const listed = layouts.map((layout) => {
    const rows = layoutRows(layout).map(record);
    const marks = new Map<string, PublishedPosition>();
    for (const mark of published) {
      if (mark.layout_id === layout.id && (mark.kind === "tee" || mark.kind === "target") && mapCoordinates(mark)) {
        marks.set(mark.hole + ":" + mark.kind, mark);
      }
    }
    const mapHoles = rows.map((row) => {
      const hole = String(row.hole ?? row.number);
      return {
        ...row,
        tee: marks.get(hole + ":tee") ?? row.tee,
        target: marks.get(hole + ":target") ?? row.target,
      };
    });
    const summary = layoutQuality({ ...layout, holes: mapHoles });
    const firstOccurrence = new Map<number, Raw>();
    for (const row of rows) {
      const hole = positiveOperatorId(row.hole ?? row.number);
      if (hole != null && !firstOccurrence.has(hole)) firstOccurrence.set(hole, row);
    }
    const issues = summary.holes.map((hole) => {
      const source = firstOccurrence.get(hole.hole);
      const approval = record(source?.verified);
      const signId = positiveOperatorId(approval.tee_sign_id ?? source?.tee_sign_id);
      const sign = signId == null ? null : reviews.get(signId);
      const evidence = hole.parSource === "tee-sign" && sign?.hole_number === hole.hole;
      const reviewedAt = evidence ? latestTimestamp([sign?.reviewed_at]) : null;
      const verification = !evidence ? "unverified" : !reviewedAt ? "approval-date-unknown" :
        Date.parse(reviewedAt) < threshold ? "stale" : "approved";
      return { hole: hole.hole, par: hole.par, mapped: hole.mapped, missing: hole.missing, verification, reviewedAt };
    });
    const verified = issues.filter(({ verification }) => verification !== "unverified").length;
    const stale = issues.filter(({ verification }) => verification === "stale").length;
    const reviewedInWindow = issues.filter(({ reviewedAt }) => {
      const reviewedDate = reviewedAt?.slice(0, 10);
      return reviewedDate && reviewedDate >= window.from && reviewedDate <= window.to;
    }).length;
    const updatedAt = latestTimestamp([layout.updated_at, ...[...marks.values()].map((mark) => mark.updated_at)]);
    const listedAt = latestTimestamp([layout.created_at]);
    const ageDate = updatedAt ?? listedAt;
    holes += summary.holeCount;
    mappedHoles += summary.mappedCount;
    approvedPars += verified;
    staleApprovalCount += stale;
    approvalsReviewedInWindow += reviewedInWindow;
    if (COVERAGE_ORDER[summary.status] > COVERAGE_ORDER[coverage]) coverage = summary.status;
    return {
      id: layout.id, name: layout.name ?? "Layout", coverage: summary.status, holes: summary.holeCount,
      mappedHoles: summary.mappedCount, placeholderPars: summary.placeholderPars, approvedPars: verified,
      unverifiedPars: summary.holeCount - verified, staleApprovals: stale, approvalsReviewedInWindow: reviewedInWindow, updatedAt, listedAt,
      invalidRows: summary.invalidRows, unlistedHoles: summary.unlistedHoles,
      freshness: !ageDate ? "unknown" : Date.parse(ageDate) < threshold ? "stale" : "recent",
      issues,
    };
  });
  return { coverage, layouts: listed, holes, mappedHoles, approvedPars, unverifiedPars: holes - approvedPars, staleApprovals: staleApprovalCount,
    approvalsReviewedInWindow, pendingTeeSigns: signs.filter((row) => row.status === "candidate").length, staleAfterDays: STALE_DAYS };
}

export type Participation = {
  completedRounds: number; completedCompetitionRecords: number; completedCasualCards: number;
  completedPlayerEntries: number; uniqueIdentifiedPlayers: number; guestEntries: number;
};

export const OPERATOR_CSV_COLUMNS = ["record_type", "course_id", "course_name", "from", "to", "layout_or_task_id",
  "label", "status", "metric", "value", "details", "due_date", "updated_at"];

export function operatorCsvRow(...cells: (string | number | undefined | null)[]): string {
  return OPERATOR_CSV_COLUMNS.map((_, index) => escapePlayCsv(cells[index])).join(",") + "\r\n";
}
