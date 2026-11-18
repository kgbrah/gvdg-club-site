// Course search for the Lost & Found forms: type a few letters (name or town), or tap "Use my location" to put the
// nearest courses first. The position stays on the phone (the course list is public); it is asked for only when the
// player taps the button, or read silently when this site already has location permission (the scoring app's GPS).
import React from "react";
import { LocateFixed, MapPin } from "lucide-react";

import { formatDistance, searchCourses } from "../shared/course-geo.js";

const h = React.createElement;

const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 60_000, timeout: 12_000 };

/**
 * The phone's position: { status: "idle" | "locating" | "ready" | "denied" | "unavailable", here, locate() }.
 * `auto`: read it on open when permission is already granted (never prompts on its own).
 */
export function useHere({ auto = true } = {}) {
  const [state, setState] = React.useState({ status: "idle", here: null });
  const supported = typeof navigator !== "undefined" && Boolean(navigator.geolocation);
  const locate = React.useCallback(() => {
    if (!supported) {
      setState({ status: "unavailable", here: null });
      return;
    }
    setState((current) => ({ ...current, status: "locating" }));
    navigator.geolocation.getCurrentPosition(
      (position) => setState({ status: "ready", here: { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy } }),
      (error) => setState({ status: error?.code === 1 ? "denied" : "unavailable", here: null }),
      GEO_OPTIONS,
    );
  }, [supported]);
  React.useEffect(() => {
    if (!auto || !supported || !navigator.permissions?.query) return undefined;
    let live = true;
    navigator.permissions.query({ name: "geolocation" }).then((permission) => {
      if (live && permission.state === "granted") locate();
    }).catch(() => {});
    return () => { live = false; };
  }, [auto, supported, locate]);
  return { ...state, locate, supported };
}

function placeLine(course, meters) {
  return [course.location, formatDistance(meters)].filter(Boolean).join(" · ");
}

/**
 * `courses`: [{ id, name, location, lat, lng }]. `value`: the chosen course id ("" for none). `here`: useHere().
 * `note`: a line under the chosen course ("Filled in from your location").
 * Filter mode (`clearLabel`, e.g. "All courses"): the chosen course gets a button to clear it, and results show only
 * once something is typed or "Near me" is tapped, so the list page stays short.
 */
export function CoursePicker({ id, label = "Course", courses, value, onChange, here, note, error, clearLabel, locateLabel = "Use my location" }) {
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [askedNearby, setAskedNearby] = React.useState(false);
  const filter = Boolean(clearLabel);
  const input = React.useRef(null);
  const listId = id + "-results";
  const chosen = value ? courses.find((course) => String(course.id) === String(value)) : null;
  const position = here?.status === "ready" ? here.here : null;
  const showNearby = !filter || askedNearby;
  const results = query.trim() || showNearby ? searchCourses(courses, query, position, query.trim() ? 8 : 5) : [];

  function pick(course) {
    onChange(String(course.id));
    setQuery("");
    setSearching(false);
  }
  function change() {
    setSearching(true);
    requestAnimationFrame(() => input.current?.focus());
  }

  const locateButton = here?.supported ? h("button", {
    className: "shop-filter-reset course-locate", disabled: here.status === "locating", key: "locate",
    onClick: () => { setAskedNearby(true); here.locate(); }, type: "button",
  }, [h(LocateFixed, { "aria-hidden": true, key: "icon", size: 18 }), here.status === "locating" ? "Finding you…" : locateLabel]) : null;

  if (chosen && !searching) {
    const meters = position ? searchCourses([chosen], "", position, 1)[0]?.meters : undefined;
    return h("div", { className: "market-field course-picker" + (error ? " has-error" : ""), "data-course-picker": "chosen", "data-lf-field": "courseId" }, [
      h("span", { className: "course-picker-label", id: id + "-label", key: "label" }, label),
      h("div", { "aria-labelledby": id + "-label", className: "course-chosen", key: "chosen", role: "group" }, [
        h(MapPin, { "aria-hidden": true, className: "course-chosen-icon", key: "icon", size: 20 }),
        h("div", { className: "course-chosen-text", key: "text" }, [
          h("strong", { key: "name" }, chosen.name),
          h("small", { key: "place" }, placeLine(chosen, meters)),
        ]),
        h("button", { "aria-label": "Change course", className: "shop-filter-reset course-change", id, key: "change", onClick: change, type: "button" }, "Change"),
      ]),
      filter ? h("button", { className: "market-text-btn course-clear", key: "clear", onClick: () => onChange(""), type: "button" }, clearLabel) : null,
      note ? h("small", { className: "market-hint", key: "note" }, note) : null,
      error ? h("small", { className: "market-note error", key: "error", role: "alert" }, error) : null,
    ]);
  }

  const status = here?.status === "denied" ? "Location is off for this site. Search by name or town instead."
    : here?.status === "unavailable" ? "Couldn't find your location. Search by name or town instead."
      : here?.status === "ready" && showNearby && !query.trim() && !results.length ? "No courses near you. Search by name or town." : "";
  return h("div", { className: "market-field course-picker" + (error ? " has-error" : ""), "data-course-picker": "search", "data-lf-field": "courseId" }, [
    h("label", { htmlFor: id, key: "label" }, label),
    h("div", { className: "course-search-row", key: "row" }, [
      h("input", {
        "aria-controls": listId, autoComplete: "off", enterKeyHint: "search", id, key: "input", onChange: (event) => setQuery(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") { event.preventDefault(); if (results[0]) pick(results[0].course); }
          if (event.key === "Escape" && chosen) { event.preventDefault(); setSearching(false); }
        },
        inputMode: "search", placeholder: "Search by course or town", ref: input, type: "text", value: query,
      }),
      chosen ? h("button", { "aria-label": "Keep " + chosen.name, className: "shop-filter-reset course-cancel", key: "cancel", onClick: () => setSearching(false), type: "button" },
        "Cancel") : null,
    ]),
    locateButton,
    status ? h("small", { className: "market-hint", key: "status", role: "status" }, status) : null,
    results.length ? h("ul", { "aria-label": query.trim() ? "Matching courses" : "Courses near you", className: "course-results", id: listId, key: "results" },
      results.map(({ course, meters }) => h("li", { key: course.id },
        h("button", { className: "course-result", "data-course-id": course.id, onClick: () => pick(course), type: "button" }, [
          h("strong", { key: "name" }, course.name),
          h("small", { key: "place" }, placeLine(course, meters)),
        ])))) : null,
    query.trim() && !results.length ? h("small", { className: "market-hint", key: "none", role: "status" }, "No course matches “" + query.trim() + "”.") : null,
    error ? h("small", { className: "market-note error", key: "error", role: "alert" }, error) : null,
  ]);
}
