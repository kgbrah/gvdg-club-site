// Club workdays on Member Home: displays open/active workdays, posted karma rewards, everyone already signed up,
// and lets signed-in members sign up and check in via GPS once on site.
import React from "react";
import { Hammer, MapPin } from "lucide-react";

import { request, requestJson } from "./api.js";
import { formatEventDay } from "./format.js";
import { AddToCalendarButton } from "../shared/add-to-calendar.js";
import { calendarEventFromWorkday } from "../shared/event-calendar.js";
import { KarmaChip, invalidateKarmaDirectory } from "../shared/karma.js";

const h = React.createElement;

function checkinErrorMessage(error, workday) {
  const code = error?.data?.error;
  if (code === "too_far") {
    const dist = error.data?.distanceFt != null ? `${Number(error.data.distanceFt).toLocaleString()} ft away` : "outside the workday zone";
    const rad = error.data?.radiusFt != null ? `${Number(error.data.radiusFt).toLocaleString()} ft` : "the workday radius";
    return `You appear to be ${dist} (must be within ${rad} of ${workday.locationName}). Move closer and try again.`;
  }
  if (code === "checkin_not_open") return `GPS check-in opens on ${formatEventDay(workday.workdayDate)}.`;
  if (code === "workday_missing_gps") return "An admin hasn't saved a GPS pin for this workday yet.";
  if (code === "not_signed_up") return "Sign up first before checking in.";
  if (code === "already_verified") return "Your attendance is already verified.";
  if (code === "workday_closed") return "This workday is closed.";
  return "Couldn't check in right now. Try again in a moment.";
}

function geoPosition() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(Object.assign(new Error("gps_unavailable"), { geoCode: "unavailable" }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        lat: coords.latitude,
        lng: coords.longitude,
        accuracyM: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
      }),
      (err) => reject(Object.assign(new Error("gps_failed"), { geoCode: err?.code })),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
    );
  });
}

function WorkdayCardRow({ workday, busy, feedback, onSignup, onCancelSignup, onGpsCheckin }) {
  const me = workday.me;
  const signups = Array.isArray(workday.signups) ? workday.signups : [];
  const signedUp = Boolean(me && me.status !== "no_show");
  const isVerified = me?.status === "verified";
  const isCheckedIn = me?.status === "checked_in";
  const when = [formatEventDay(workday.workdayDate), workday.startTime, workday.locationName].filter(Boolean).join(" · ");
  const statusChip = isVerified ? "Verified"
    : isCheckedIn ? "GPS checked in"
      : workday.checkinOpen ? "Check-in open"
        : "Sign-up open";

  return h("article", {
    className: "member-workday-item",
    "data-member-workday": workday.id,
  }, [
    h("div", { className: "member-workday-head", key: "head" }, [
      h("div", { className: "member-workday-title-wrap", key: "copy" }, [
        h("h3", { className: "member-workday-title", key: "title" }, workday.title),
        when ? h("p", { className: "player-card-meta", key: "when" }, when) : null,
      ]),
      h("span", { className: "player-chip member-workday-karma", key: "karma" }, `+${workday.karmaReward} karma`),
    ]),
    workday.description ? h("p", { className: "player-card-meta member-workday-desc", key: "desc" }, workday.description) : null,
    h("div", { className: "player-chip-row", key: "chips" }, [
      h("span", { className: `player-chip${workday.checkinOpen && !isVerified ? " live" : ""}`, key: "status" }, statusChip),
      workday.hasGps ? h("span", { className: "player-chip", key: "radius" }, `GPS within ${Number(workday.radiusFt || 2000).toLocaleString()} ft`) : null,
    ].filter(Boolean)),
    h("div", { className: "member-workday-roster-box", "data-member-workday-roster": workday.id, key: "roster" }, [
      h("div", { className: "member-workday-roster-head", key: "head" }, `Signed up (${signups.length})`),
      signups.length ? h("ul", { className: "member-workday-roster", key: "list" }, signups.map((person, index) => (
        h("li", { className: "member-workday-person", key: `${person.name}-${index}` }, [
          h("span", { className: "karma-line", key: "who" }, [
            h("span", { className: "member-workday-name", key: "name" }, person.name),
            h(KarmaChip, { key: "karma", karmaKey: person.karmaKey }),
          ]),
          h("span", { className: "member-workday-tags", key: "tags" }, [
            person.isMe ? h("span", { className: "member-workday-tag is-me", key: "me" }, "You") : null,
            person.status === "verified" ? h("span", { className: "member-workday-tag is-verified", key: "st" }, "Verified")
              : person.status === "checked_in" ? h("span", { className: "member-workday-tag is-checked-in", key: "st" }, "Checked in")
                : null,
          ].filter(Boolean)),
        ])
      ))) : h("p", { className: "player-card-meta", key: "empty" }, "Be the first to sign up!"),
    ]),
    isVerified ? h("p", { className: "member-workday-status is-verified", key: "verified-note", role: "status" },
      `Verified! You earned +${me.karmaAwarded} karma.`) : null,
    isCheckedIn ? h("p", { className: "member-workday-status", key: "checked-in-note", role: "status" },
      `GPS verified${me.gpsDistanceFt != null ? ` (${me.gpsDistanceFt} ft)` : ""}. Waiting for an admin to verify +${workday.karmaReward} karma.`) : null,
    signedUp && !isVerified && !isCheckedIn && (!workday.checkinOpen || !workday.hasGps) ? h("p", { className: "player-card-meta", key: "wait-note" },
      !workday.hasGps
        ? "Waiting for an admin to set the GPS pin before check-in opens."
        : `GPS check-in opens on ${formatEventDay(workday.workdayDate)}.`) : null,
    feedback?.text ? h("p", {
      className: feedback.ok ? "member-workday-status" : "member-workday-status is-error",
      key: "feedback",
      role: feedback.ok ? "status" : "alert",
    }, feedback.text) : null,
    !isVerified ? h("div", { className: "member-action-grid", key: "actions" }, [
      !signedUp ? h("button", {
        className: "player-btn primary",
        disabled: busy,
        key: "signup",
        onClick: () => void onSignup(workday.id),
        type: "button",
      }, busy ? "Signing up…" : "Sign up") : null,
      signedUp && !isCheckedIn && workday.checkinOpen && workday.hasGps ? h("button", {
        className: "player-btn primary",
        disabled: busy,
        key: "checkin",
        onClick: () => void onGpsCheckin(workday),
        type: "button",
      }, [
        h(MapPin, { "aria-hidden": true, key: "icon", size: 16 }),
        busy ? "Checking in…" : "Check in with GPS",
      ]) : null,
      signedUp ? h("button", {
        className: "player-btn",
        disabled: busy,
        key: "cancel",
        onClick: () => void onCancelSignup(workday.id),
        type: "button",
      }, "Cancel sign-up") : null,
      h(AddToCalendarButton, {
        className: "player-btn",
        item: calendarEventFromWorkday(workday),
        key: "cal",
        label: "Calendar",
      }),
    ].filter(Boolean)) : null,
  ]);
}

export function WorkdaysHomeCard({ token }) {
  const [workdays, setWorkdays] = React.useState([]);
  const [status, setStatus] = React.useState("loading");
  const [busyId, setBusyId] = React.useState(null);
  const [feedback, setFeedback] = React.useState({});
  const bustedRef = React.useRef("");

  const load = React.useCallback((signal) => {
    if (!token) return Promise.resolve();
    return requestJson("/workdays", { signal, token })
      .then((data) => {
        if (signal?.aborted) return;
        const rows = Array.isArray(data?.workdays) ? data.workdays : [];
        setWorkdays(rows);
        setStatus("ready");
        const verifiedKey = rows
          .filter((w) => w.me?.status === "verified")
          .map((w) => `${w.id}:${w.me.karmaAwarded}`)
          .join(",");
        if (verifiedKey && verifiedKey !== bustedRef.current) {
          bustedRef.current = verifiedKey;
          void invalidateKarmaDirectory();
        }
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setStatus("ready");
      });
  }, [token]);

  React.useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void load(controller.signal);
    const onTab = (event) => {
      if (event.detail?.tab === "overview") void load();
    };
    window.addEventListener("gvdg:dashboard-tab-selected", onTab);
    return () => {
      controller.abort();
      window.removeEventListener("gvdg:dashboard-tab-selected", onTab);
    };
  }, [load, token]);

  function replaceWorkday(updated) {
    if (!updated) return;
    setWorkdays((current) => current.map((row) => (row.id === updated.id ? updated : row)));
  }

  async function onSignup(id) {
    setBusyId(id);
    setFeedback((c) => ({ ...c, [id]: null }));
    try {
      const data = await requestJson(`/workdays/${id}/signup`, { method: "POST", token });
      replaceWorkday(data.workday);
      setFeedback((c) => ({ ...c, [id]: { ok: true, text: "You're signed up!" } }));
    } catch {
      setFeedback((c) => ({ ...c, [id]: { ok: false, text: "Couldn't sign up right now. Try again." } }));
    } finally {
      setBusyId(null);
    }
  }

  async function onCancelSignup(id) {
    setBusyId(id);
    setFeedback((c) => ({ ...c, [id]: null }));
    try {
      const data = await requestJson(`/workdays/${id}/signup`, { method: "DELETE", token });
      replaceWorkday(data.workday);
      setFeedback((c) => ({ ...c, [id]: { ok: true, text: "Sign-up removed." } }));
    } catch {
      setFeedback((c) => ({ ...c, [id]: { ok: false, text: "Couldn't cancel sign-up right now." } }));
    } finally {
      setBusyId(null);
    }
  }

  async function onGpsCheckin(workday) {
    setBusyId(workday.id);
    setFeedback((c) => ({ ...c, [workday.id]: { ok: true, text: "Checking your GPS location…" } }));
    let coords;
    try {
      coords = await geoPosition();
    } catch (error) {
      setBusyId(null);
      const message = error?.geoCode === 1
        ? "Location access is off. Allow location in your browser settings to verify workday GPS check-in."
        : error?.geoCode === 3
          ? "GPS check-in timed out. Step into open sky and try again."
          : "Couldn't read GPS from this device.";
      setFeedback((c) => ({ ...c, [workday.id]: { ok: false, text: message } }));
      return;
    }
    try {
      const response = await request(`/workdays/${workday.id}/check-in`, {
        body: coords,
        method: "POST",
        token,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback((c) => ({ ...c, [workday.id]: { ok: false, text: checkinErrorMessage({ data, status: response.status }, workday) } }));
        return;
      }
      replaceWorkday(data.workday);
      setFeedback((c) => ({
        ...c,
        [workday.id]: {
          ok: true,
          text: `Checked in (${data.distanceFt} ft from ${workday.locationName}). An admin can now confirm your +${workday.karmaReward} karma.`,
        },
      }));
    } catch {
      setFeedback((c) => ({ ...c, [workday.id]: { ok: false, text: checkinErrorMessage(null, workday) } }));
    } finally {
      setBusyId(null);
    }
  }

  if (status !== "ready" || !workdays.length) return null;

  return h("section", {
    "aria-label": "Club workdays",
    className: "player-card member-workdays-card",
    "data-react-home-workdays": "ready",
  }, [
    h("div", { className: "member-workdays-head", key: "head" }, [
      h("h2", { key: "title" }, [
        h(Hammer, { "aria-hidden": true, key: "icon", size: 19 }),
        workdays.length === 1 ? "Club workday" : "Club workdays",
      ]),
    ]),
    ...workdays.map((workday) => h(WorkdayCardRow, {
      busy: busyId === workday.id,
      feedback: feedback[workday.id],
      key: workday.id,
      onCancelSignup,
      onGpsCheckin,
      onSignup,
      workday,
    })),
  ]);
}
