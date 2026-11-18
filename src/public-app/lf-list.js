// Lost & Found lists: Found discs and Lost discs, with search and a course filter.
import React from "react";

import { discTitle, holdingText, postHref, postMeta, POST_STATUS_LABELS } from "../shared/lost-found-model.js";
import { LfLoad, LfPhoto, lfRequest, PersonLine, useLfVersion } from "./lf-ui.js";

const h = React.createElement;

export function PostCard({ post, showPoster = true }) {
  const href = postHref(post.id);
  const title = discTitle(post);
  const status = post.status === "open" ? null : POST_STATUS_LABELS[post.status] || post.status;
  return h("article", { className: "product-card market-card lf-card", "data-lf-post": post.id, "data-lf-kind": post.kind, "data-status": post.status }, [
    h("a", { "aria-hidden": "true", className: "market-card-photo", href, key: "photo", tabIndex: -1 }, [
      h(LfPhoto, { alt: "", key: "img", pending: !post.photos?.length && post.photoPending > 0, photo: post.photos?.[0] }),
      status ? h("span", { className: "market-chip market-chip-pending market-card-flag", key: "flag" }, status) : null,
    ]),
    h("div", { className: "product-body", key: "body" }, [
      h("span", { className: "market-kicker", key: "kind" }, post.kind === "lost" ? "LOST" : "FOUND"),
      h("a", { className: "product-name market-card-title", href, key: "name" }, title),
      h("div", { className: "product-meta", key: "meta" }, postMeta(post)),
      post.kind === "found" && post.status !== "returned" ? h("div", { className: "product-meta", key: "where" }, holdingText(post)) : null,
      post.kind === "lost" && post.rewardNote ? h("div", { className: "product-meta lf-reward", key: "reward" }, "Reward: " + post.rewardNote) : null,
      showPoster && post.poster ? h("div", { className: "product-meta market-card-seller", key: "poster" }, h(PersonLine, { link: false, person: post.poster })) : null,
    ]),
  ]);
}

function useDebounced(value, delay) {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

let coursesPromise = null;
export function useCourses() {
  const [courses, setCourses] = React.useState([]);
  React.useEffect(() => {
    let live = true;
    if (!coursesPromise) {
      coursesPromise = lfRequest("/courses").then(({ ok, data }) => (ok && Array.isArray(data.courses) ? data.courses : []))
        .then((rows) => rows.filter((row) => row && Number(row.id) > 0 && typeof row.name === "string")
          .map((row) => ({ id: Number(row.id), name: row.name })).sort((a, b) => a.name.localeCompare(b.name)))
        .catch(() => { coursesPromise = null; return []; });
    }
    coursesPromise.then((rows) => { if (live) setCourses(rows); });
    return () => { live = false; };
  }, []);
  return courses;
}

export function PostList({ kind, route }) {
  const courses = useCourses();
  const [q, setQ] = React.useState(() => route.query.get("q") || "");
  const [course, setCourse] = React.useState(() => route.query.get("course") || "");
  const search = useDebounced(q.trim(), 250);
  const query = new URLSearchParams({ kind, ...(search ? { q: search } : {}), ...(course ? { course } : {}) }).toString();
  const [state, setState] = React.useState({ status: "loading", posts: [], more: false, code: 0 });
  const [attempt, setAttempt] = React.useState(0);
  const version = useLfVersion();

  React.useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: "loading" }));
    lfRequest("/lost-found/posts?" + query, { signal: controller.signal }).then(({ ok, status, data }) => {
      setState(ok && Array.isArray(data.posts)
        ? { status: "ready", posts: data.posts, more: data.more === true, code: status }
        : { status: "error", posts: [], more: false, code: status });
    }).catch(() => {});
    return () => controller.abort();
  }, [query, attempt, version]);

  async function loadMore() {
    const { ok, data } = await lfRequest(`/lost-found/posts?${query}&offset=${state.posts.length}`);
    if (ok && Array.isArray(data.posts)) setState((current) => ({ ...current, posts: current.posts.concat(data.posts), more: data.more === true }));
  }

  const posts = state.posts;
  const found = kind === "found";
  return h("section", { "data-lf-state": state.status, "data-lf-view": kind }, [
    h("div", { className: "shop-catalog-bar", key: "bar" }, [
      h("h2", { key: "title" }, found ? "Found discs" : "Lost discs"),
      h("a", { className: "shop-cart-link", href: found ? "#new/found" : "#new/lost", key: "post" }, found ? "Post a found disc" : "Post a lost disc"),
    ]),
    h("div", { "aria-label": found ? "Found disc filters" : "Lost disc filters", className: "filters shop-filters market-filters lf-filters", key: "filters" }, [
      h("div", { className: "shop-search-row", key: "row" }, [
        h("label", { className: "public-sr-only", htmlFor: "lfSearch", key: "search-label" }, found ? "Search found discs" : "Search lost discs"),
        h("input", { id: "lfSearch", key: "search", maxLength: 60, onChange: (event) => setQ(event.target.value), placeholder: "Search discs", type: "search", value: q }),
        h("label", { className: "public-sr-only", htmlFor: "lfCourse", key: "course-label" }, "Course"),
        h("select", { id: "lfCourse", key: "course", onChange: (event) => setCourse(event.target.value), value: course }, [
          h("option", { key: "any", value: "" }, "Any course"),
          ...courses.map((row) => h("option", { key: row.id, value: String(row.id) }, row.name)),
        ]),
      ]),
    ]),
    state.status !== "ready" ? h(LfLoad, { key: "load", loading: found ? "Loading found discs…" : "Loading lost discs…", onRetry: () => setAttempt((value) => value + 1), state })
      : h("div", { className: "product-grid market-grid lf-grid", key: "grid" }, posts.length
        ? posts.map((post) => h(PostCard, { key: post.id, post }))
        : h("p", { className: "public-state", role: "status" }, search || course
          ? "Nothing matches that search."
          : found ? "No found discs are posted right now. Found one? Post it and we'll help it get home." : "No lost discs are posted right now.")),
    state.more ? h("button", { className: "shop-filter-reset market-more", key: "more", onClick: loadMore, type: "button" }, "Show more") : null,
  ]);
}
