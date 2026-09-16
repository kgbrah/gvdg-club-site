import React from "react";
import { createPortal } from "react-dom";
import { ChevronRight, MapPin, Navigation, Play, Target } from "lucide-react";

import { useAccessibleDialog } from "../shared/a11y.js";
import { safeExternalUrl } from "../shared/safe-url.js";

const h = React.createElement;

function icon(Icon, props = {}) {
  return h(Icon, {
    ...props,
    "aria-hidden": "true",
    focusable: "false",
    size: props.size || 20,
    strokeWidth: props.strokeWidth || 2.4,
  });
}

function directionsUrl(coords) {
  const [lat, lng] = String(coords || "").split(",").map((value) => value.trim());
  if (!lat || !lng || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) return "";
  return safeExternalUrl(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}`) || "";
}

function courseFromCard(card) {
  if (!card) return null;
  return {
    course: card.dataset.course || "Course",
    location: card.dataset.location || "Greenville, NC",
    udisc: safeExternalUrl(card.dataset.udisc || "") || "",
    directions: directionsUrl(card.dataset.coords || ""),
    youtube: safeExternalUrl(card.dataset.youtube || "") || "",
  };
}

function CourseAction({ href, iconClassName, iconNode, title, subtitle }) {
  const enabled = Boolean(href);
  const onClick = enabled ? undefined : (event) => event.preventDefault();
  return h(
    "a",
    {
      className: "course-modal-btn" + (enabled ? "" : " disabled"),
      href: enabled ? href : "#",
      target: enabled ? "_blank" : undefined,
      rel: enabled ? "noopener noreferrer" : undefined,
      "aria-disabled": enabled ? undefined : "true",
      tabIndex: enabled ? undefined : -1,
      onClick,
    },
    [
      h("div", { className: `course-modal-btn-icon ${iconClassName}`, key: "icon" }, iconNode),
      h("div", { className: "course-modal-btn-text", key: "text" }, [
        h("div", { className: "course-modal-btn-title", key: "title" }, title),
        h("div", { className: "course-modal-btn-subtitle", key: "subtitle" }, subtitle),
      ]),
      icon(ChevronRight, { className: "course-modal-btn-arrow", key: "arrow", size: 18 }),
    ],
  );
}

export function CourseModal() {
  const [course, setCourse] = React.useState(null);
  const close = React.useCallback(() => setCourse(null), []);
  const dialog = useAccessibleDialog({
    open: Boolean(course),
    onClose: close,
    labelledBy: "course-modal-title",
    label: "Course details",
  });

  React.useEffect(() => {
    function handleClick(event) {
      const card = event.target instanceof Element ? event.target.closest(".course-card[data-course]") : null;
      if (!card) return;
      event.preventDefault();
      setCourse(courseFromCard(card));
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  if (!course) return null;

  return createPortal(
    h(
      "div",
      {
        className: "course-modal-overlay active",
        "data-react-course-modal": "open",
        role: "presentation",
        ref: dialog.overlayRef,
      },
      h("div", {
        className: "course-modal",
        role: "dialog",
        "aria-modal": dialog.isolated ? "true" : undefined,
        "aria-labelledby": "course-modal-title",
        "aria-label": "Course details",
        tabIndex: -1,
        ref: dialog.panelRef,
      }, [
      h("div", { className: "course-modal-header", key: "header" }, [
        h("h3", { className: "course-modal-title", id: "course-modal-title", key: "title" }, course.course),
        h("p", { className: "course-modal-location", key: "location" }, [
          icon(MapPin, { key: "icon", size: 16 }),
          h("span", { key: "text" }, course.location),
        ]),
      ]),
      h("div", { className: "course-modal-options", key: "options" }, [
        h(CourseAction, {
          href: course.udisc,
          iconClassName: "udisc",
          iconNode: icon(Target, { size: 24 }),
          title: "View on UDisc",
          subtitle: "Course info, layouts & reviews",
          key: "udisc",
        }),
        h(CourseAction, {
          href: course.directions,
          iconClassName: "directions",
          iconNode: icon(Navigation, { size: 24 }),
          title: "Get Directions",
          subtitle: "Open in Google Maps",
          key: "directions",
        }),
        h(CourseAction, {
          href: course.youtube,
          iconClassName: "youtube",
          iconNode: icon(Play, { size: 24 }),
          title: "Course Preview",
          subtitle: course.youtube ? "Watch on YouTube" : "Coming soon",
          key: "youtube",
        }),
      ]),
      h("button", { className: "course-modal-close", type: "button", onClick: close, key: "close" }, "Close"),
    ]),
    ),
    document.body,
  );
}
