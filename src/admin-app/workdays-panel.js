// Admin > Events > Workdays: announce club workdays with posted karma rewards, set the course/GPS
// check-in pin, verify GPS-checked-in participants, and award their karma.
import React from "react";

import { adminRequest } from "./admin-api.js";
import { adminConfirm } from "./admin-dialogs.js";
import { CLUB_TIME_ZONE } from "../shared/events-model.js";
import { KarmaChip } from "../shared/karma.js";

const h = React.createElement;

const RADIUS_OPTIONS = [
  ["1000", "1,000 ft (~0.2 mi)"],
  ["2000", "2,000 ft (~0.38 mi)"],
  ["3500", "3,500 ft (~0.66 mi)"],
  ["5280", "5,280 ft (1 mile)"],
];

function easternToday() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: CLUB_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const ymd = `${get("year")}-${get("month")}-${get("day")}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function emptyForm() {
  return {
    title: "",
    workdayDate: easternToday(),
    startTime: "9:00 AM",
    courseId: "",
    locationName: "",
    lat: "",
    lng: "",
    radiusFt: "2000",
    karmaReward: "25",
    status: "open",
    description: "",
  };
}

async function apiJson(path, options) {
  try {
    const response = await adminRequest(path, options);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } };
  }
}

function geoMessage(error) {
  if (error?.code === 1) return "Location permission was denied. Allow location access or pick a mapped course.";
  if (error?.code === 3) return "GPS fix timed out. Step outside or pick a mapped course.";
  return "Couldn't read GPS from this device.";
}

function WorkdayCard({ workday, busyId, onPatch, onVerifyAll, onVerifyOne, onSetParticipantStatus }) {
  const [note, setNote] = React.useState("");
  const busy = busyId === workday.id;
  const participants = Array.isArray(workday.participants) ? workday.participants : [];
  const gpsPending = participants.filter((p) => p.status === "checked_in" && p.gpsVerified).length;
  const isOpen = workday.status === "open" || workday.status === "active";
  const statusLabel = workday.status === "completed" ? "Completed"
    : workday.status === "cancelled" ? "Cancelled"
      : workday.checkinOpen ? "Check-in open" : "Sign-up open";

  return h("article", {
    className: "admin-surface admin-workday-card",
    "data-admin-workday": workday.id,
  }, [
    h("div", { className: "admin-workday-head", key: "head" }, [
      h("h3", { className: "admin-workday-title", key: "title" }, workday.title),
      h("div", { className: "admin-workday-badges", key: "badges" }, [
        h("span", { className: `admin-badge${workday.checkinOpen && isOpen ? " live" : ""}`, key: "status" }, statusLabel),
        h("span", { className: "admin-workday-karma", key: "karma" }, `+${workday.karmaReward} karma`),
      ]),
    ]),
    h("p", { className: "admin-event-meta", key: "meta" }, [
      workday.workdayDate,
      workday.startTime || null,
      workday.locationName,
    ].filter(Boolean).join(" · ")),
    h("p", { className: "al-note", key: "gps" }, workday.hasGps
      ? `GPS check-in radius: ${Number(workday.radiusFt || 2000).toLocaleString()} ft · ${workday.signupCount} signed up · ${workday.verifiedCount} verified`
      : `No GPS pin saved yet · ${workday.signupCount} signed up · ${workday.verifiedCount} verified`),
    workday.description ? h("p", { className: "al-note admin-workday-desc", key: "desc" }, workday.description) : null,
    isOpen ? h("div", { className: "admin-action-grid admin-workday-actions", key: "actions" }, [
      workday.status === "open" ? h("button", {
        className: "admin-btn secondary",
        disabled: busy,
        key: "activate",
        onClick: () => void onPatch(workday.id, { status: "active" }),
        type: "button",
      }, "Open check-in now") : null,
      gpsPending > 0 ? h("button", {
        className: "admin-btn",
        disabled: busy,
        key: "verify-all",
        onClick: () => void onVerifyAll(workday.id),
        type: "button",
      }, `Verify all GPS check-ins (${gpsPending})`) : null,
      h("button", {
        className: "admin-btn secondary",
        disabled: busy,
        key: "complete",
        onClick: async () => {
          if (gpsPending > 0) {
            const ok = await adminConfirm({
              title: "Complete workday?",
              message: `${gpsPending} GPS-checked-in participant(s) are still unverified. Complete without verifying them?`,
              confirmText: "Complete workday",
            });
            if (!ok) return;
          }
          void onPatch(workday.id, { status: "completed" });
        },
        type: "button",
      }, "Complete workday"),
      h("button", {
        className: "admin-btn danger",
        disabled: busy,
        key: "cancel",
        onClick: async () => {
          const ok = await adminConfirm({
            title: "Cancel workday?",
            message: `Cancel "${workday.title}" and notify signed-up participants?`,
            confirmText: "Cancel workday",
            danger: true,
          });
          if (ok) void onPatch(workday.id, { status: "cancelled" });
        },
        type: "button",
      }, "Cancel workday"),
    ].filter(Boolean)) : null,
    h("div", { className: "admin-workday-roster", key: "roster" }, [
      h("h4", { className: "al-h", key: "heading" }, `Participants (${participants.length})`),
      participants.length ? h("ul", { className: "admin-workday-list", key: "list" }, participants.map((p) => (
        h("li", {
          className: "admin-evrow admin-workday-participant",
          "data-admin-workday-participant": p.memberId,
          key: p.memberId,
        }, [
          h("span", { className: "ev-name karma-line", key: "who" }, [
            h("span", { key: "name" }, p.memberName),
            h(KarmaChip, { key: "karma", karmaKey: p.karmaKey }),
          ]),
          h("span", { className: "admin-event-meta", key: "state" },
            p.status === "verified" ? `Verified · +${p.karmaAwarded} karma awarded`
              : p.status === "checked_in" ? `GPS verified (${p.gpsDistanceFt != null ? `${p.gpsDistanceFt} ft` : "on site"})`
                : p.status === "no_show" ? "Marked no-show"
                  : "Signed up · awaiting GPS check-in"),
          isOpen && p.status !== "verified" ? h("div", { className: "admin-action-grid", key: "p-actions" }, [
            p.status === "checked_in" && p.gpsVerified ? h("button", {
              className: "admin-btn",
              disabled: busy,
              key: "verify",
              onClick: () => void onVerifyOne(workday.id, p.memberId, { allowWithoutGps: false }),
              type: "button",
            }, `Verify & award +${workday.karmaReward} karma`) : null,
            p.status === "signed_up" ? h("button", {
              className: "admin-btn secondary",
              disabled: busy,
              key: "override",
              onClick: async () => {
                const ok = await adminConfirm({
                  title: "Verify without GPS?",
                  message: `${p.memberName} has not checked in with GPS yet. Award +${workday.karmaReward} karma anyway?`,
                  confirmText: `Award +${workday.karmaReward} karma`,
                });
                if (ok) void onVerifyOne(workday.id, p.memberId, { allowWithoutGps: true, note });
              },
              type: "button",
            }, "Verify without GPS") : null,
            p.status === "no_show" ? h("button", {
              className: "admin-btn secondary",
              disabled: busy,
              key: "restore",
              onClick: () => void onSetParticipantStatus(workday.id, p.memberId, "signed_up"),
              type: "button",
            }, "Restore") : h("button", {
              className: "admin-btn secondary",
              disabled: busy,
              key: "no-show",
              onClick: () => void onSetParticipantStatus(workday.id, p.memberId, "no_show"),
              type: "button",
            }, "No-show"),
          ].filter(Boolean)) : null,
        ])
      ))) : h("p", { className: "al-note", key: "empty" }, "No sign-ups yet."),
      isOpen && participants.some((p) => p.status === "signed_up") ? h("label", { className: "al-note admin-workday-note-label", key: "note" }, [
        "Optional note for manual GPS override",
        h("input", {
          key: "i",
          maxLength: 200,
          onChange: (event) => setNote(event.target.value),
          placeholder: "e.g. Phone battery died",
          type: "text",
          value: note,
        }),
      ]) : null,
    ]),
  ]);
}

export function AdminWorkdaysPanel() {
  const [form, setForm] = React.useState(emptyForm);
  const [courses, setCourses] = React.useState([]);
  const [workdays, setWorkdays] = React.useState([]);
  const [status, setStatus] = React.useState("loading");
  const [submitting, setSubmitting] = React.useState(false);
  const [busyId, setBusyId] = React.useState(null);
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    const [workdaysRes, coursesRes] = await Promise.all([
      apiJson("/admin/workdays"),
      apiJson("/courses"),
    ]);
    if (coursesRes.ok && Array.isArray(coursesRes.data?.courses)) setCourses(coursesRes.data.courses);
    if (!workdaysRes.ok) {
      setStatus("error");
      return;
    }
    setWorkdays(Array.isArray(workdaysRes.data?.workdays) ? workdaysRes.data.workdays : []);
    setStatus("ready");
    window.dispatchEvent(new CustomEvent("gvdg:admin-needs-refresh"));
  }, []);

  React.useEffect(() => {
    void load();
    const onTab = (event) => { if (event.detail?.tab === "workdays") void load(); };
    const onHash = () => { if (/#workdays/.test(window.location.hash)) void load(); };
    window.addEventListener("gvdg:admin-active-tab", onTab);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("gvdg:admin-active-tab", onTab);
      window.removeEventListener("hashchange", onHash);
    };
  }, [load]);

  function selectCourse(value) {
    const course = courses.find((c) => String(c.id) === String(value));
    setForm((current) => ({
      ...current,
      courseId: value,
      locationName: course ? course.name : current.locationName,
      lat: course && course.lat != null ? String(course.lat) : value ? "" : current.lat,
      lng: course && course.lng != null ? String(course.lng) : value ? "" : current.lng,
    }));
  }

  function pinMyGps() {
    setError("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("GPS isn't supported in this browser.");
      return;
    }
    setNotice("Reading GPS coordinates…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setForm((current) => ({
          ...current,
          lat: Number(coords.latitude).toFixed(6),
          lng: Number(coords.longitude).toFixed(6),
        }));
        setNotice("Pinned your current GPS location.");
      },
      (err) => {
        setNotice("");
        setError(geoMessage(err));
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
    );
  }

  async function announce(event) {
    event.preventDefault();
    if (submitting) return;
    setError("");
    setNotice("");
    const body = {
      title: form.title.trim(),
      workdayDate: form.workdayDate,
      startTime: form.startTime.trim() || null,
      courseId: form.courseId ? Number(form.courseId) : null,
      locationName: form.locationName.trim(),
      lat: form.lat.trim() === "" ? null : Number(form.lat),
      lng: form.lng.trim() === "" ? null : Number(form.lng),
      radiusFt: Number(form.radiusFt),
      karmaReward: Number(form.karmaReward),
      status: form.status,
      description: form.description.trim() || null,
    };
    setSubmitting(true);
    const result = await apiJson("/admin/workdays", { method: "POST", body });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.data?.error === "missing_location" ? "Enter a course or location name."
        : result.data?.error === "invalid_gps" ? "Enter both latitude and longitude (or clear both)."
          : result.data?.error === "invalid_karma" ? "Karma reward must be between 1 and 500."
            : "Couldn't announce the workday. Check fields and try again.");
      return;
    }
    const count = Number(result.data?.notifiedCount) || 0;
    const saved = result.data?.workday;
    setForm(emptyForm());
    setNotice(`Announced "${saved?.title || body.title}" (+${saved?.karmaReward ?? body.karmaReward} karma) to ${count} active member(s).`);
    await load();
  }

  async function patchWorkday(id, body) {
    setBusyId(id);
    setError("");
    const res = await apiJson(`/admin/workdays/${id}`, { method: "PATCH", body });
    setBusyId(null);
    if (!res.ok) setError("Couldn't update workday.");
    else await load();
  }

  async function verifyAllGps(id) {
    setBusyId(id);
    setError("");
    setNotice("");
    const res = await apiJson(`/admin/workdays/${id}/verify-all-gps`, { method: "POST", body: {} });
    setBusyId(null);
    if (!res.ok) setError("Couldn't verify GPS check-ins.");
    else {
      setNotice(`Verified ${res.data?.verifiedCount || 0} GPS check-in(s) and awarded karma.`);
      await load();
    }
  }

  async function verifyParticipant(id, memberId, body) {
    setBusyId(id);
    setError("");
    setNotice("");
    const res = await apiJson(`/admin/workdays/${id}/participants/${encodeURIComponent(memberId)}/verify`, { method: "POST", body });
    setBusyId(null);
    if (!res.ok) {
      setError(res.data?.error === "gps_required" ? "Participant has not checked in with GPS yet."
        : res.data?.error === "already_verified" ? "Already verified." : "Couldn't verify participant.");
    } else {
      const p = res.data?.participant;
      setNotice(`Verified ${p?.memberName || "participant"} (+${p?.karmaAwarded || 0} karma).`);
      await load();
    }
  }

  async function setParticipantStatus(id, memberId, nextStatus) {
    setBusyId(id);
    setError("");
    const res = await apiJson(`/admin/workdays/${id}/participants/${encodeURIComponent(memberId)}/status`, {
      method: "POST",
      body: { status: nextStatus },
    });
    setBusyId(null);
    if (!res.ok) setError("Couldn't update participant.");
    else await load();
  }

  const upcoming = workdays.filter((w) => w.status === "open" || w.status === "active");
  const past = workdays.filter((w) => w.status === "completed" || w.status === "cancelled");

  return h("div", { className: "admin-workdays", "data-admin-workdays": status }, [
    h("form", { className: "admin-form admin-surface", key: "form", onSubmit: announce }, [
      h("h2", { className: "al-h", key: "heading" }, "Announce a club workday"),
      h("p", { className: "al-note", key: "sub" }, "All active members get an in-app alert and push notification, can sign up from Home, check in by GPS on site, and earn the posted karma once you verify attendance."),
      h("div", { key: "title" }, [
        h("label", { htmlFor: "wdTitle", key: "l" }, "Workday title"),
        h("input", {
          id: "wdTitle", key: "i", maxLength: 120, required: true, placeholder: "e.g. Saturday Course Cleanup",
          onChange: (event) => setForm((c) => ({ ...c, title: event.target.value })), value: form.title,
        }),
      ]),
      h("div", { className: "admin-registration-fees", key: "when" }, [
        h("label", { htmlFor: "wdDate", key: "d" }, [
          "Date",
          h("input", {
            id: "wdDate", key: "i", required: true, type: "date",
            onChange: (event) => setForm((c) => ({ ...c, workdayDate: event.target.value })), value: form.workdayDate,
          }),
        ]),
        h("label", { htmlFor: "wdTime", key: "t" }, [
          "Start time",
          h("input", {
            id: "wdTime", key: "i", maxLength: 24, placeholder: "9:00 AM",
            onChange: (event) => setForm((c) => ({ ...c, startTime: event.target.value })), value: form.startTime,
          }),
        ]),
        h("label", { htmlFor: "wdKarma", key: "k" }, [
          "Karma reward",
          h("input", {
            id: "wdKarma", key: "i", max: 500, min: 1, required: true, step: 1, type: "number",
            onChange: (event) => setForm((c) => ({ ...c, karmaReward: event.target.value })), value: form.karmaReward,
          }),
        ]),
      ]),
      h("div", { key: "course" }, [
        h("label", { htmlFor: "wdCourse", key: "l" }, "Course (fills GPS pin automatically)"),
        h("select", {
          id: "wdCourse", key: "i", value: form.courseId,
          onChange: (event) => selectCourse(event.target.value),
        }, [
          h("option", { key: "none", value: "" }, "Custom location"),
          ...courses.map((course) => h("option", { key: course.id, value: String(course.id) }, course.name)),
        ]),
      ]),
      h("div", { key: "loc" }, [
        h("label", { htmlFor: "wdLocation", key: "l" }, "Location name"),
        h("input", {
          id: "wdLocation", key: "i", maxLength: 140, required: true, placeholder: "Course or meeting spot",
          onChange: (event) => setForm((c) => ({ ...c, locationName: event.target.value })), value: form.locationName,
        }),
      ]),
      h("div", { className: "admin-workday-gps-row", key: "gps" }, [
        h("label", { htmlFor: "wdLat", key: "lat" }, [
          "Latitude",
          h("input", {
            id: "wdLat", key: "i", step: "any", type: "number", placeholder: "35.6127",
            onChange: (event) => setForm((c) => ({ ...c, lat: event.target.value })), value: form.lat,
          }),
        ]),
        h("label", { htmlFor: "wdLng", key: "lng" }, [
          "Longitude",
          h("input", {
            id: "wdLng", key: "i", step: "any", type: "number", placeholder: "-77.3664",
            onChange: (event) => setForm((c) => ({ ...c, lng: event.target.value })), value: form.lng,
          }),
        ]),
        h("label", { htmlFor: "wdRadius", key: "rad" }, [
          "GPS check-in radius",
          h("select", {
            id: "wdRadius", key: "i", value: form.radiusFt,
            onChange: (event) => setForm((c) => ({ ...c, radiusFt: event.target.value })),
          }, RADIUS_OPTIONS.map(([v, label]) => h("option", { key: v, value: v }, label))),
        ]),
        h("button", { className: "admin-btn secondary", key: "pin", onClick: pinMyGps, type: "button" }, "Use my GPS"),
      ]),
      h("div", { key: "mode" }, [
        h("label", { htmlFor: "wdStatus", key: "l" }, "Check-in availability"),
        h("select", {
          id: "wdStatus", key: "i", value: form.status,
          onChange: (event) => setForm((c) => ({ ...c, status: event.target.value })),
        }, [
          h("option", { key: "open", value: "open" }, "Sign-up now (GPS check-in opens on workday date)"),
          h("option", { key: "active", value: "active" }, "Open sign-up & GPS check-in immediately"),
        ]),
      ]),
      h("div", { key: "desc" }, [
        h("label", { htmlFor: "wdDesc", key: "l" }, "Details (optional)"),
        h("textarea", {
          id: "wdDesc", key: "i", maxLength: 1000, rows: 3, placeholder: "Tools needed, meeting spot, tasks",
          onChange: (event) => setForm((c) => ({ ...c, description: event.target.value })), value: form.description,
        }),
      ]),
      error ? h("p", { className: "al-note", key: "err", role: "alert" }, error) : null,
      notice ? h("p", { className: "al-note", key: "note", role: "status" }, notice) : null,
      h("button", { className: "admin-btn", disabled: submitting, key: "submit", type: "submit" }, submitting ? "Announcing…" : "Announce workday & notify members"),
    ]),
    status === "loading" ? h("p", { className: "al-note", key: "loading", role: "status" }, "Loading workdays…") : null,
    status === "error" ? h("p", { className: "al-note", key: "load-err", role: "alert" }, "Couldn't load workdays.") : null,
    status === "ready" ? h("section", { className: "admin-workdays-list", key: "upcoming", "aria-label": "Upcoming and active workdays" }, [
      h("h3", { className: "al-h", key: "title" }, upcoming.length ? `Active & upcoming workdays (${upcoming.length})` : "No active workdays"),
      ...upcoming.map((workday) => h(WorkdayCard, {
        busyId,
        key: workday.id,
        onPatch: patchWorkday,
        onSetParticipantStatus: setParticipantStatus,
        onVerifyAll: verifyAllGps,
        onVerifyOne: verifyParticipant,
        workday,
      })),
    ]) : null,
    past.length ? h("details", { className: "admin-surface admin-details", key: "past" }, [
      h("summary", { key: "sum" }, `Past & cancelled workdays (${past.length})`),
      ...past.map((workday) => h(WorkdayCard, {
        busyId,
        key: workday.id,
        onPatch: patchWorkday,
        onSetParticipantStatus: setParticipantStatus,
        onVerifyAll: verifyAllGps,
        onVerifyOne: verifyParticipant,
        workday,
      })),
    ]) : null,
  ]);
}
