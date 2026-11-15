import React from "react";
import { Bookmark, ChevronRight } from "lucide-react";
import { selectDashboardTab } from "./dashboard-shell.js";
import { communityRequest } from "./community-panel.js";
import { memberConfirm } from "./member-dialogs.js";
import { readMemberToken } from "../shared/member-session.js";
import { AMENITY_OPTIONS, communityDate, COURSE_AMENITIES, COURSE_DIFFICULTIES, REVIEW_REASONS } from "../shared/community-labels.js";

const h = React.createElement;
const EMPTY_FILTER = { q: "", difficulty: "", favorites: false, amenities: {} };

function option(value, label) { return h("option", { value, key: value }, label); }
function action(label, props = {}) { return h("button", { className: "dashboard-action", type: "button", ...props }, label); }
function status(text, key = "status") { return text ? h("p", { className: "dash-note", role: "status", key }, text) : null; }

function Rating({ course, as = "p" }) {
  return h(as, { className: "player-card-meta" }, course.reviewCount
    ? Number(course.averageRating).toFixed(1) + "/5 · " + course.reviewCount + (course.reviewCount === 1 ? " review" : " reviews")
    : "No published reviews");
}

function CourseChips({ course }) {
  const level = COURSE_DIFFICULTIES.find(([value]) => value === course.difficulty);
  const amenities = COURSE_AMENITIES.filter(([key]) => course.amenities?.[key] === "yes");
  if ((!level || level[0] === "unknown") && !amenities.length) return null;
  return h("span", { className: "course-chips", key: "chips" }, [
    level && level[0] !== "unknown" ? h("span", { className: "course-chip level-" + level[0], key: "level" }, level[1]) : null,
    ...amenities.slice(0, 3).map(([key, label]) => h("span", { className: "course-chip", key }, label)),
    amenities.length > 3 ? h("span", { className: "course-chip", key: "more" }, "+" + (amenities.length - 3)) : null,
  ]);
}

function CourseInfo({ course }) {
  const difficulty = COURSE_DIFFICULTIES.find(([value]) => value === course.difficulty)?.[1] || "Unknown";
  return h("section", { className: "player-card", "aria-label": "Course amenities and access" }, [
    h("h2", { key: "name" }, course.name),
    course.location ? h("p", { className: "player-card-meta", key: "town" }, course.location) : null,
    h(Rating, { course, as: "span", key: "rating" }),
    h("p", { key: "difficulty" }, "Difficulty · " + difficulty),
    h("ul", { className: "community-list community-amenities", key: "amenities" }, COURSE_AMENITIES.map(([key, label]) => h("li", { key }, [
      h("span", { key: "label" }, label),
      h("strong", { key: "value" }, AMENITY_OPTIONS.find(([val]) => val === course.amenities[key])?.[1] || "Unknown"),
    ]))),
    course.notes ? h("p", { className: "community-body", key: "notes" }, course.notes) : null,
    status(course.updatedAt ? "Course details checked " + communityDate(course.updatedAt) : "Course amenities have yet to be confirmed.", "updated"),
    h("a", { className: "dashboard-action", href: "score.html?course=" + encodeURIComponent(course.name), key: "map" }, "Open course map"),
  ]);
}

function ReviewEditor({ mine, submit, remove, disabled }) {
  const latest = mine && mine.state !== "removed" ? mine : null;
  const [rating, setRating] = React.useState(String(latest?.rating || ""));
  const [text, setText] = React.useState(latest?.text || "");
  const [editing, setEditing] = React.useState(false);
  const label = latest?.state === "published" ? "Published" : latest?.state === "hidden" ? "Hidden by moderation" : "Awaiting moderation";

  if (!editing) return h("section", { className: "player-card", "aria-label": "Your review" }, [
    h("h2", { key: "title" }, "Your review"),
    latest ? status(label + " · " + communityDate(latest.updatedAt), "visibility") : null,
    latest ? h("p", { className: "community-body", key: "body" }, latest.rating + "/5" + (latest.text ? " · " + latest.text : "")) : null,
    h("div", { className: "dashboard-actions", key: "actions" }, [
      action(latest ? "Edit review" : "Write a review", { key: "edit", onClick: () => setEditing(true), disabled }),
      latest ? action("Remove review", { key: "remove", disabled, onClick: () => { void remove(latest); } }) : null,
    ]),
  ]);

  return h("form", { className: "player-card community-form", onSubmit: async (event) => {
    event.preventDefault();
    if (await submit({ rating: Number(rating), text, revision: mine?.revision || 0 })) setEditing(false);
  } }, [
    h("h2", { key: "title" }, latest ? "Edit review" : "Write a review"),
    status("Ratings and comments appear after club moderation. Edits return a published review to the queue."),
    h("label", { className: "community-field", key: "rating" }, [
      "Rating", h("select", { className: "form-input", "aria-label": "Rating", required: true, value: rating, key: "select", onChange: (event) => setRating(event.target.value) },
        [option("", "Choose a rating"), ...[5, 4, 3, 2, 1].map((value) => option(String(value), value + " out of 5"))]),
    ]),
    h("label", { className: "community-field", key: "comment" }, [
      "Course review", h("textarea", { className: "form-input", maxLength: 1200, rows: 4, value: text, onChange: (event) => setText(event.target.value), key: "input" }),
    ]),
    h("div", { className: "dashboard-actions", key: "actions" }, [
      action("Send for moderation", { type: "submit", className: "dashboard-action primary", disabled, key: "send" }),
      action("Cancel", { onClick: () => setEditing(false), key: "cancel" }),
    ]),
  ]);
}

function PublishedReview({ row, report, busy }) {
  const [reason, setReason] = React.useState("");
  const [open, setOpen] = React.useState(false);
  return h("li", null, [
    h("strong", { key: "rating" }, row.rating + "/5"),
    status("Published " + communityDate(row.publishedAt), "date"),
    row.text ? h("p", { className: "community-body", key: "review" }, row.text) : null,
    row.reported ? status("Report sent", "reported") : !row.own && !open ? action("Report review", {
      key: "report", onClick: () => setOpen(true), disabled: busy,
    }) : null,
    !row.reported && !row.own && open ? h("form", { className: "community-form", key: "reasons", onSubmit: async (event) => {
      event.preventDefault();
      if (await report(row, reason)) setOpen(false);
    } }, [
      h("label", { className: "community-field", key: "label" }, [
        "Reason for report", h("select", { className: "form-input", "aria-label": "Reason for report", key: "select", value: reason, required: true, onChange: (event) => setReason(event.target.value) },
          [option("", "Choose a reason"), ...REVIEW_REASONS.map(([value, label]) => option(value, label))]),
      ]),
      action("Send report", { key: "send", type: "submit", disabled: busy }),
    ]) : null,
  ]);
}

function CourseReviews({ courseId, token, favorite, toggleFavorite }) {
  const [data, setData] = React.useState(null);
  const [version, reload] = React.useReducer((value) => value + 1, 0);
  const [offset, setOffset] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const valid = () => readMemberToken() === token;
  React.useEffect(() => {
    const controller = new AbortController();
    communityRequest(`/community/courses/${courseId}/reviews?offset=${offset}`, { token, signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted || !valid()) return;
        setData((prior) => offset && prior ? { ...rows, reviews: [...prior.reviews, ...rows.reviews.filter((row) => !prior.reviews.some((previous) => previous.id === row.id))] } : rows);
      })
      .catch(() => { if (!controller.signal.aborted) setMessage("Course details couldn’t load."); });
    return () => controller.abort();
  }, [courseId, token, version, offset]);

  async function update(href, method, body, success) {
    if (busy || !valid()) return false;
    setBusy(true);
    setMessage("");
    try {
      await communityRequest(href, { token, method, body });
      if (!valid()) return false;
      setMessage(success);
      setOffset(0);
      reload();
      return true;
    } catch (error) {
      if (valid()) setMessage(error.status === 409 ? "Your review changed. Refresh before editing it again." : "This change couldn’t be saved.");
      return false;
    } finally { setBusy(false); }
  }

  if (!valid() || !data) return status(message || "Loading course details…");
  const reviewRoute = `/me/community/courses/${courseId}/review`;
  const remove = async (mine) => {
    const agreed = await memberConfirm({
      title: "Remove your course review?",
      message: "The rating and text will be removed from the course.",
      confirmText: "Remove review", danger: true,
    });
    if (agreed) await update(reviewRoute, "DELETE", { revision: mine.revision }, "Review removed.");
  };
  return h("div", { className: "member-community player-play member-subpage member-course-details", "data-course-community": courseId }, [
    action("‹ Back to course results", { key: "back", onClick: () => selectDashboardTab("course-discovery") }),
    h(CourseInfo, { course: data.course, key: "course" }),
    action(favorite ? "Remove favorite" : "Save as favorite", { key: "favorite", onClick: () => { void toggleFavorite(courseId); } }),
    status(message),
    h(ReviewEditor, {
      key: "review-" + (data.mine?.revision ?? 0), mine: data.mine, disabled: busy, remove,
      submit: (body) => update(reviewRoute, "PUT", body, "Review sent for moderation."),
    }),
    h("section", { className: "player-card", "aria-label": "Published course reviews", key: "published" }, [
      h("h2", { key: "title" }, "Course reviews"),
      data.reviews.length ? h("ul", { className: "community-list", key: "list" }, data.reviews.map((row) => h(PublishedReview, {
        row, busy, key: row.id, report: (item, reason) => update("/me/community/reviews/" + item.id + "/report", "PUT", { revision: item.revision, reason }, "Report sent to moderation."),
      }))) : status("No published reviews yet."),
      data.more ? action("More reviews", { key: "more", onClick: () => setOffset(offset + 20) }) : null,
    ]),
  ]);
}

export function MemberCourseDiscovery({ courseId, token }) {
  const [filter, setFilter] = React.useState(EMPTY_FILTER);
  const [applied, apply] = React.useState(EMPTY_FILTER);
  const [page, setPage] = React.useState({ courses: [], more: false, offset: 0, loading: true });
  const [favorites, setFavorites] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [version, reload] = React.useReducer((value) => value + 1, 0);
  const valid = () => token === readMemberToken();

  React.useEffect(() => {
    const controller = new AbortController();
    communityRequest("/me/course-favorites", { token, signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted && valid()) setFavorites(data.courseIds || []); })
      .catch(() => {});
    return () => controller.abort();
  }, [token]);

  function query(offset) {
    const params = new URLSearchParams({ q: applied.q, offset: String(offset) });
    if (applied.difficulty) params.set("difficulty", applied.difficulty);
    if (applied.favorites) params.set("favorites", "1");
    for (const [key] of COURSE_AMENITIES) if (applied.amenities[key]) params.set(key, applied.amenities[key]);
    return params;
  }

  React.useEffect(() => {
    if (courseId) return undefined;
    const controller = new AbortController();
    setPage((current) => ({ ...current, loading: true }));
    communityRequest("/community/courses?" + query(0), { token, signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted && valid()) setPage({ ...data, offset: 0, loading: false }); })
      .catch(() => {
        if (controller.signal.aborted || !valid()) return;
        setPage({ courses: [], more: false, offset: 0, loading: false, error: true });
      });
    return () => controller.abort();
  }, [applied, courseId, token, version]);

  async function toggleFavorite(course) {
    if (!valid() || busy) return;
    setBusy(true);
    setMessage("");
    const saved = favorites.includes(Number(course));
    try {
      await communityRequest("/me/course-favorites/" + course, { token, method: saved ? "DELETE" : "PUT" });
      if (!valid()) return;
      setFavorites((rows) => saved ? rows.filter((id) => id !== Number(course)) : [...rows, Number(course)]);
      setMessage(saved ? "Favorite removed." : "Course saved to favorites.");
      if (applied.favorites) reload();
    } catch { if (valid()) setMessage("Couldn’t update favorites."); }
    finally { setBusy(false); }
  }

  async function older() {
    setBusy(true);
    try {
      const offset = page.offset + 25;
      const result = await communityRequest("/community/courses?" + query(offset), { token });
      if (valid()) setPage({ courses: page.courses.concat(result.courses), more: result.more, offset, loading: false });
    } catch { setMessage("More courses couldn’t load."); }
    finally { setBusy(false); }
  }

  if (!valid()) return null;
  if (courseId) return h(React.Fragment, null, [
    h(CourseReviews, { key: courseId, courseId, token, favorite: favorites.includes(Number(courseId)), toggleFavorite }),
    status(message),
  ]);
  return h("div", { className: "member-community player-play member-subpage member-course-discovery", "data-member-course-discovery": "ready" }, [
    h("form", { className: "player-card community-form member-discovery-filters", role: "search", key: "form", onSubmit: (event) => {
      event.preventDefault();
      setMessage("");
      apply({ ...filter, q: filter.q.trim() });
    } }, [
      h("label", { className: "community-field", key: "name" }, [
        "Course or town", h("input", { className: "form-input", type: "search", maxLength: 80, key: "input", value: filter.q, onChange: (event) => setFilter({ ...filter, q: event.target.value }) }),
      ]),
      h("label", { key: "favorites" }, [
        h("input", { type: "checkbox", key: "check", checked: filter.favorites, onChange: (event) => setFilter({ ...filter, favorites: event.target.checked }) }), " Favorites only",
      ]),
      h("details", { key: "filter" }, [
        h("summary", { key: "label" }, "Amenities and accessibility"),
        h("div", { className: "community-grid", key: "options" }, [
          h("label", { className: "community-field", key: "difficulty" }, [
            "Difficulty", h("select", { className: "form-input", key: "select", value: filter.difficulty, onChange: (event) => setFilter({ ...filter, difficulty: event.target.value }) },
              [option("", "Any"), ...COURSE_DIFFICULTIES.map(([val, text]) => option(val, text))]),
          ]),
          ...COURSE_AMENITIES.map(([key, label]) => h("label", { className: "community-field", key }, [
            label, h("select", {
              className: "form-input", key: "select", value: filter.amenities[key] || "",
              onChange: (event) => setFilter({ ...filter, amenities: { ...filter.amenities, [key]: event.target.value } }),
            }, [option("", "Any"), ...AMENITY_OPTIONS.map(([val, text]) => option(val, text))]),
          ])),
        ]),
      ]),
      h("div", { className: "dashboard-actions", key: "buttons" }, [
        action("Find courses", { className: "dashboard-action primary", key: "search", type: "submit" }),
        action("Reset filters", { key: "reset", onClick: () => { setFilter(EMPTY_FILTER); apply(EMPTY_FILTER); } }),
      ]),
    ]),
    status(message),
    page.loading ? status("Loading courses…", "loading") : page.error ? h("div", { className: "member-subactions", key: "error" }, [
      h("p", { className: "dash-note", role: "alert", key: "message" }, "Courses couldn’t load."),
      action("Try again", { onClick: reload, key: "retry" }),
    ]) : !page.courses.length ? status("No courses match these filters.", "empty") : null,
    h("ul", { className: "member-course-results member-link-list", key: "courses" }, page.courses.map((course) => {
      const favorite = favorites.includes(course.id);
      return h("li", { key: course.id }, [
        h("button", {
          className: "member-course-link", type: "button", key: "course", "aria-label": "Course details for " + course.name,
          onClick: () => selectDashboardTab("course-discovery", { courseId: course.id }),
        }, [
          h("span", { className: "member-link-copy", key: "copy" }, [
            h("strong", { key: "name" }, course.name),
            course.location ? h("small", { key: "town" }, course.location) : null,
            h(Rating, { course, as: "span", key: "rating" }),
            h(CourseChips, { course, key: "chips" }),
          ]),
          h(ChevronRight, { size: 17, "aria-hidden": true, key: "arrow" }),
        ]),
        h("button", {
          className: "member-course-favorite", key: "favorite", type: "button", disabled: busy,
          "aria-label": favorite ? "Remove favorite" : "Save as favorite", title: favorite ? "Remove favorite" : "Save as favorite",
          "aria-pressed": favorite, onClick: () => { void toggleFavorite(course.id); },
        }, h(Bookmark, { size: 19, fill: favorite ? "currentColor" : "none", "aria-hidden": true })),
      ]);
    })),
    page.more ? action("More courses", { key: "more", disabled: busy, onClick: () => { void older(); } }) : null,
  ]);
}
