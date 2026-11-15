import type { Env } from "./env.js";
import { adminGate } from "./authz.js";
import { corsHeaders, json, readJson } from "./http.js";
import {
  COVERAGE_DEFINITION, PARTICIPATION_DEFINITION, OPERATOR_CSV_COLUMNS, operatorCsvRow, operatorWindow, parseTaskChange, positiveOperatorId, TASK_STATUSES,
  type CourseListing, type OperatorWindow, type TaskStatus,
} from "./course-operator.js";
import {
  exportTaskPage, getOperatorCoverage, getOperatorCourse, getOperatorParticipation, latestTaskId, listMaintenanceTasks,
  listOperatorCourses, saveMaintenanceTask,
} from "./course-operator-store.js";

const PRIVATE = { "Cache-Control": "private, no-store" };

async function exportCourseHealth(env: Env, course: CourseListing, window: OperatorWindow, origin: string | null) {
  const [health, participation, lastId] = await Promise.all([
    getOperatorCoverage(env.DB, course.id, window), getOperatorParticipation(env.DB, course.id, window), latestTaskId(env.DB, course.id),
  ]);
  const prefix = [
    OPERATOR_CSV_COLUMNS.join(",") + "\r\n",
    operatorCsvRow("definition", course.id, course.name, window.from, window.to, null, "Participation scope",
      null, null, null, PARTICIPATION_DEFINITION),
    operatorCsvRow("definition", course.id, course.name, window.from, window.to, null, "Coverage scope",
      null, null, null, COVERAGE_DEFINITION),
  ];
  for (const [metric, count] of Object.entries(participation)) {
    prefix.push(operatorCsvRow("participation", course.id, course.name, window.from, window.to, null, null, null, metric, count));
  }
  for (const layout of health.layouts) {
    prefix.push(operatorCsvRow("layout_review_activity", course.id, course.name, window.from, window.to, layout.id, layout.name,
      null, "approvalsReviewedInWindow", layout.approvalsReviewedInWindow));
    for (const [metric, count] of Object.entries({ holes: layout.holes, mappedHoles: layout.mappedHoles,
      approvedPars: layout.approvedPars, unverifiedPars: layout.unverifiedPars, staleApprovals: layout.staleApprovals,
      placeholderPars: layout.placeholderPars, invalidRows: layout.invalidRows, unlistedHoles: layout.unlistedHoles,
    })) {
      prefix.push(operatorCsvRow("layout", course.id, course.name, null, null, layout.id, layout.name, layout.coverage,
        metric, count, null, null, layout.updatedAt));
    }
  }

  const encoder = new TextEncoder();
  let after = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix.join("")));
      if (!lastId) controller.close();
    },
    async pull(controller) {
      const page = await exportTaskPage(env.DB, course.id, after, lastId);
      if (!page.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(page.map((task) =>
        operatorCsvRow("task", course.id, course.name, null, null, task.id, task.title, task.status,
          "priority", task.priority, task.details, task.dueDate, task.updatedAt),
      ).join("")));
      after = page.at(-1)!.id;
      if (after >= lastId) controller.close();
    },
  });
  return new Response(body, { headers: {
    ...corsHeaders(origin), ...PRIVATE, "X-Content-Type-Options": "nosniff", "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="gvdg-course-' + course.id + '-health.csv"',
  } });
}

export async function handleCourseHealth(request: Request, env: Env, origin: string | null): Promise<Response> {
  const gate = await adminGate(request, env, origin);
  if (gate instanceof Response) return gate;
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;
  if (parts[0] !== "admin" || parts[1] !== "course-health" || parts.length > 5) {
    return json({ error: "not_found" }, 404, origin, PRIVATE);
  }
  if (parts.length === 2 && method === "GET") {
    return json({ courses: await listOperatorCourses(env.DB) }, 200, origin, PRIVATE);
  }
  const courseId = positiveOperatorId(parts[2]);
  if (courseId == null) return json({ error: "not_found" }, 404, origin, PRIVATE);
  const course = await getOperatorCourse(env.DB, courseId);
  if (!course) return json({ error: "not_found" }, 404, origin, PRIVATE);
  if (method === "GET" && (parts.length === 3 || (parts.length === 4 && parts[3] === "export"))) {
    const window = operatorWindow(url.searchParams);
    if (!window) return json({ error: "invalid_date_range" }, 400, origin, PRIVATE);
    if (parts.length === 4) return exportCourseHealth(env, course, window, origin);
    const [health, participation] = await Promise.all([
      getOperatorCoverage(env.DB, courseId, window), getOperatorParticipation(env.DB, courseId, window),
    ]);
    return json({ course, window, health, participation, participationDefinition: PARTICIPATION_DEFINITION, coverageDefinition: COVERAGE_DEFINITION }, 200, origin, PRIVATE);
  }
  if (parts[3] !== "tasks") return json({ error: "not_found" }, 404, origin, PRIVATE);
  if (parts.length === 4 && method === "GET") {
    const status = url.searchParams.get("status") ?? "all";
    const rawBefore = url.searchParams.get("before");
    const before = rawBefore == null ? null : positiveOperatorId(rawBefore);
    if ((status !== "all" && !TASK_STATUSES.includes(status as TaskStatus)) || (rawBefore != null && before == null)) {
      return json({ error: "invalid_task_filter" }, 400, origin, PRIVATE);
    }
    return json(await listMaintenanceTasks(env.DB, courseId, status as TaskStatus | "all", before), 200, origin, PRIVATE);
  }
  const creating = parts.length === 4 && method === "POST";
  const editing = parts.length === 5 && method === "PATCH";
  const taskId = editing ? positiveOperatorId(parts[4]) : null;
  if ((!creating && !editing) || (editing && taskId == null)) return json({ error: "not_found" }, 404, origin, PRIVATE);
  const change = parseTaskChange(await readJson(request, 12_000), editing);
  if (!change) return json({ error: "invalid_task" }, 400, origin, PRIVATE);
  const saved = await saveMaintenanceTask(env.DB, courseId, taskId, change);
  if ("error" in saved) return json(saved, saved.error === "not_found" ? 404 : 409, origin, PRIVATE);
  return json(saved, creating && !saved.replayed ? 201 : 200, origin, PRIVATE);
}
