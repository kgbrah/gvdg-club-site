import React from "react";
import { CalendarDays, CheckCircle2 } from "lucide-react";

import { humanDate } from "../shared/events-display.js";
import { displayEventTitle, formatLabel, isPastClubCalendarEvent, normalizeEvent } from "../shared/events-model.js";
import { EventScheduleFacts } from "../shared/event-schedule.js";
import { EventFieldRoster } from "../shared/event-field-roster.js";
import { clientOwed, isDoublesRegistration, isTeamRegistration, parseArray, parseObject } from "../members-app/registration-utils.js";
import { publicApiBase } from "./public-api.js";
import { clearMemberSession, readMemberToken } from "../shared/member-session.js";
import { guestRegs, setGuestReg } from "./guest-registrations.js";
import { TournamentRegistration } from "./tournament-registration.js";

const h = React.createElement;
const REGISTRATION_REFRESH_EVENT = "gvdg:events-registration-refresh";

function icon(Icon, size = 16) {
  return h(Icon, {
    "aria-hidden": "true",
    focusable: "false",
    size,
    strokeWidth: 2.4,
  });
}

function apiBase() {
  return publicApiBase();
}

function memberToken() {
  return readMemberToken() || null;
}


function isArchivedClubEvent(raw) {
  return isPastClubCalendarEvent(normalizeEvent(raw));
}

function dollars(cents) {
  return "$" + (Math.round(Number(cents) || 0) / 100).toFixed(2).replace(/\.00$/, "");
}

async function fetchJson(base, path) {
  const response = await fetch(`${base}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

async function regApi(base, path, opts = {}) {
  const headers = { Accept: "application/json" };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = "Bearer " + opts.token;
  return fetch(base + path, {
    method: opts.method || "GET",
    cache: "no-store",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

function eventKey(event, index) {
  return [
    event && event.id,
    event && event.name,
    event && event.date,
    String(index),
  ].filter(Boolean).join("|");
}

function registrationError(response, error) {
  if (response.status === 401 || error.error === "session_expired") {
    return "Your members session expired. Register as a guest below or sign in again on the Members page.";
  }
  if (error.error === "registration_closed") return "Registration is closed for this event.";
  if (error.error === "rate_limited") return "Too many sign-ups from your network. Please try again in a minute.";
  if (error.error === "invalid_division") return "Please pick a valid division.";
  if (error.error === "invalid_team") return "Please pick a team.";
  return "Registration could not be completed.";
}

function EventMeta({ event }) {
  return h(React.Fragment, null, [
    event.date
      ? h("div", { className: "event-meta", key: "date" }, h("div", { className: "meta-row" }, [
        h("span", { className: "meta-icon", key: "icon" }, icon(CalendarDays)),
        h("span", { key: "date" }, String(event.date)),
      ]))
      : null,
    h(EventScheduleFacts, { event, key: "schedule" }),
  ]);
}

function RegisteredCardActions({ api, event, guestReg, myReg, onRefresh, token }) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  async function withdraw() {
    if (!confirming) {
      setError("");
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const path = `/events/${encodeURIComponent(event.id)}/register${guestReg ? `?gt=${encodeURIComponent(guestReg.guestToken)}` : ""}`;
      const response = await regApi(api, path, { method: "DELETE", token: myReg ? token : undefined });
      if (response.ok) {
        if (guestReg) setGuestReg(event.id, null);
        await onRefresh();
        return;
      }
      const body = await response.json().catch(() => ({}));
      setError(body.error === "paid_contact_admin"
        ? "You have already paid. Please contact an admin to withdraw."
        : "Withdraw failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return h(React.Fragment, null, [
    error ? h("div", { className: "register-error", key: "error", role: "alert" }, error) : null,
    confirming
      ? h("div", { className: "register-confirm", key: "confirm" }, [
        h("button", {
          className: "reg-btn secondary",
          disabled: busy,
          key: "confirm",
          onClick: withdraw,
          type: "button",
        }, busy ? "Withdrawing…" : "Confirm withdraw"),
        h("button", {
          className: "reg-btn tertiary",
          disabled: busy,
          key: "cancel",
          onClick: () => {
            setConfirming(false);
            setError("");
          },
          type: "button",
        }, "Cancel"),
      ])
      : h("button", {
        className: "reg-btn secondary",
        disabled: busy,
        key: "withdraw",
        onClick: withdraw,
        type: "button",
      }, "Withdraw"),
  ]);
}

function RegisterForm({ api, event, onRefresh, onSessionExpired, token }) {
  const divisions = React.useMemo(() => parseArray(event.divisions), [event.divisions]);
  const teams = React.useMemo(() => parseArray(event.teams), [event.teams]);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [division, setDivision] = React.useState(() => divisions[0] || "");
  const [team, setTeam] = React.useState("");
  const [ctp, setCtp] = React.useState(false);
  const [ace, setAce] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const nameRef = React.useRef(null);
  const doubles = isDoublesRegistration(event);
  const teamEvent = isTeamRegistration(event);

  React.useEffect(() => {
    setDivision(divisions[0] || "");
    setTeam("");
  }, [event.id]);

  async function submit() {
    const body = {
      division: divisions.length ? division : null,
      addons: {
        ctp: Boolean(ctp && event.ctp_fee_cents),
        ace: Boolean(ace && event.ace_fee_cents),
      },
    };
    if (teamEvent && teams.length && !team) {
      setError("Please pick a team.");
      return;
    }
    if (doubles) body.team = team.trim();
    else if (teamEvent && teams.length) body.team = team;
    if (!token) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError("Please enter your name.");
        nameRef.current?.focus();
        return;
      }
      body.name = trimmedName;
      const trimmedEmail = email.trim();
      if (trimmedEmail) body.email = trimmedEmail;
    }

    setBusy(true);
    setError("");
    try {
      const response = await regApi(api, `/events/${encodeURIComponent(event.id)}/register`, {
        method: "POST",
        token: token || undefined,
        body,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401 || payload.error === "session_expired") {
          clearMemberSession();
          onSessionExpired();
        }
        setError(registrationError(response, payload));
        return;
      }
      const payload = await response.json().catch(() => ({}));
      if (!token && payload.guestToken) {
        setGuestReg(event.id, {
          addons: body.addons,
          division: body.division,
          guestToken: payload.guestToken,
          name: body.name,
          team: body.team || null,
        });
      }
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return h("div", { className: "register-form" }, [
    !token ? h("input", {
      className: "reg-input",
      key: "name",
      maxLength: 80,
      onChange: (event) => setName(event.target.value),
      "aria-label": "Your name",
      placeholder: "Your name",
      ref: nameRef,
      type: "text",
      value: name,
    }) : null,
    !token ? h("input", {
      className: "reg-input",
      key: "email",
      maxLength: 120,
      onChange: (event) => setEmail(event.target.value),
      "aria-label": "Email (optional)",
      placeholder: "Email (optional)",
      type: "email",
      value: email,
    }) : null,
    divisions.length ? h("select", {
      "aria-label": "Division",
      className: "reg-input",
      key: "division",
      onChange: (event) => setDivision(event.target.value),
      value: division,
    }, divisions.map((item) => h("option", { key: item, value: item }, item))) : null,
    teamEvent && teams.length ? h("select", {
      "aria-label": "Team",
      className: "reg-input",
      key: "team-menu",
      onChange: (event) => setTeam(event.target.value),
      value: team,
    }, [
      h("option", { key: "empty", value: "" }, "Select team"),
      ...teams.map((item) => h("option", { key: item, value: item }, item)),
    ]) : null,
    doubles ? h("input", {
      className: "reg-input",
      "data-register-pair": "team",
      key: "team",
      maxLength: 40,
      onChange: (event) => setTeam(event.target.value),
      "aria-label": "Pair label or partner",
      placeholder: "Pair label or partner",
      type: "text",
      value: team,
    }) : null,
    event.ctp_fee_cents ? h("label", { className: "register-addon", key: "ctp" }, [
      h("input", {
        checked: ctp,
        key: "input",
        onChange: (event) => setCtp(event.target.checked),
        type: "checkbox",
      }),
      h("span", { key: "label" }, `CTP pot ${dollars(event.ctp_fee_cents)}`),
    ]) : null,
    event.ace_fee_cents ? h("label", { className: "register-addon", key: "ace" }, [
      h("input", {
        checked: ace,
        key: "input",
        onChange: (event) => setAce(event.target.checked),
        type: "checkbox",
      }),
      h("span", { key: "label" }, `Ace pot ${dollars(event.ace_fee_cents)}`),
    ]) : null,
    error ? h("div", { className: "register-error", key: "error", role: "alert" }, error) : null,
    h("button", {
      className: "reg-btn",
      disabled: busy,
      key: "submit",
      onClick: submit,
      type: "button",
    }, busy ? "Registering…" : "Register"),
  ]);
}

function RegistrationCard({ api, event, guestReg, inline = false, myReg, onRefresh, onSessionExpired, token }) {
  const registered = Boolean(myReg || guestReg);
  const who = myReg
    ? myReg.division ? ` - ${myReg.division}` : ""
    : guestReg && guestReg.name ? ` - ${guestReg.name}` : "";
  const addons = myReg ? parseObject(myReg.addons) : guestReg ? parseObject(guestReg.addons) : {};
  const owed = registered ? clientOwed(event, addons) : 0;

  const feeText = `${event.entry_fee_cents ? `${dollars(event.entry_fee_cents)} entry` : "Free entry"}${event.play_format ? ` - ${formatLabel(event.play_format)}` : ""}`;
  // Inline (event page) mode: the page already shows title, schedule and field, so only the fee line + sign-up control render.
  const summary = [
    event.date || event.starts_at ? humanDate(event.date || event.starts_at) : "",
    event.entry_fee_cents ? `${dollars(event.entry_fee_cents)} entry` : "Free entry",
    event.play_format ? formatLabel(event.play_format) : "",
  ].filter(Boolean).join(" · ");

  return h("article", { className: `event-card register-card${inline ? " inline" : ""}`, "data-react-events-registration-card": "true" }, [
    inline ? null : h("div", { className: "event-card-top", key: "top" },
      h("h3", { className: "event-name" }, displayEventTitle(event.name || "Event"))),
    inline ? null : h(EventMeta, { event, key: "meta" }),
    h("div", { className: "register-fee", key: "fee" }, inline ? [h("span", { className: "meta-icon", key: "icon" }, icon(CalendarDays)), h("span", { key: "text" }, summary)] : feeText),
    inline ? null : h(EventFieldRoster, { compact: true, key: "field", players: event.field }),
    registered ? h("div", { className: "register-status", key: "status" }, [
      h("span", { className: "meta-icon", key: "icon" }, icon(CheckCircle2)),
      h("span", { key: "text" }, `Registered${who}`),
    ]) : null,
    registered && owed > 0 && !(myReg && myReg.paid_entry)
      ? h("div", { className: "register-fee", key: "owed" },
        `Amount due: ${dollars(owed)} - pay at the event${token ? " or in the Members area." : "."}`)
      : null,
    registered
      ? h(RegisteredCardActions, { api, event, guestReg, key: "actions", myReg, onRefresh, token })
      : h("details", { className: "event-registration-form", key: "registration-form" }, [
          h("summary", { key: "summary" }, "Sign up"),
          h(RegisterForm, { api, event, key: "form", onRefresh, onSessionExpired, token }),
        ]),
  ]);
}

function useRegistrationState() {
  const api = React.useMemo(apiBase, []);
  const [events, setEvents] = React.useState([]);
  const [myRegs, setMyRegs] = React.useState({});
  const [guestMap, setGuestMap] = React.useState({});
  const [token, setToken] = React.useState(memberToken);

  const load = React.useCallback(async () => {
    const nextToken = memberToken();
    setToken(nextToken);
    let open = [];
    try {
      const data = await fetchJson(api, "/registration/open");
      open = Array.isArray(data && data.events) ? data.events.filter((event) => !isArchivedClubEvent(event)) : [];
    } catch {
      open = [];
    }
    const registrations = {};
    if (nextToken) {
      try {
        const response = await regApi(api, "/my-registrations", { token: nextToken });
        if (response.ok) {
          const payload = await response.json();
          (payload.registrations || []).forEach((row) => {
            registrations[row.event_id] = row;
          });
        }
      } catch {
      }
    }
    setEvents(open);
    setMyRegs(registrations);
    setGuestMap(guestRegs());
  }, [api]);

  React.useEffect(() => {
    load();
    window.addEventListener(REGISTRATION_REFRESH_EVENT, load);
    return () => window.removeEventListener(REGISTRATION_REFRESH_EVENT, load);
  }, [load]);

  return { api, events, guestMap, load, myRegs, setToken, token };
}

function cardProps(state, event) {
  const id = event && event.id;
  return {
    api: state.api,
    event,
    guestReg: id != null ? state.guestMap[id] || null : null,
    myReg: id != null ? state.myRegs[id] || null : null,
    onRefresh: state.load,
    onSessionExpired: () => state.setToken(null),
    token: state.token,
  };
}

/** Reuses the hub's registration card on the event page (only when the event is open for sign-up). */
export function EventRegistrationPanel({ eventId }) {
  const state = useRegistrationState();
  const event = state.events.find((item) => String(item && item.id) === String(eventId));
  if (!event) return null;
  // A club-run PDGA event registers with its PDGA rules, the paid field and waitlist, and payment on the page.
  if (event.pdga_event_id) return h(TournamentRegistration, { event, onChanged: state.load });
  return h("section", { className: "event-register-panel", "data-react-events-registration": "inline" }, [
    h("h2", { className: "roster-title", key: "title" }, "Register"),
    h(RegistrationCard, { ...cardProps(state, event), inline: true, key: "card" }),
  ]);
}

export function EventsRegistrationApp() {
  const state = useRegistrationState();
  const { events } = state;
  if (!events.length) return null;

  return h("section", { "data-react-events-registration": "true" }, [
    h("div", { className: "events-group-head", key: "head" }, [
      h("h2", { className: "events-section-title", key: "title" }, "Currently Registering"),
      h("p", { className: "events-group-sub", key: "sub" }, "Sign up for upcoming club events – members or guests"),
    ]),
    h("div", { className: "events-grid", key: "grid" }, events.map((event, index) =>
      h(RegistrationCard, { ...cardProps(state, event), key: eventKey(event, index) }))),
  ]);
}
