export function parseArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseObject(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function eventFromRegistration(row) {
  return {
    _synth: true,
    id: row.event_id,
    name: row.event_name || "Event",
    date: row.event_date || null,
    status: row.event_status || null,
    course_name: row.course_name || null,
    layout_name: row.layout_name || null,
    starts_at: row.event_starts_at || null,
    registration_deadline: row.event_registration_deadline || null,
    checkin_deadline: row.event_checkin_deadline || null,
  };
}

export function registrationLiveConfig(event) {
  const raw = event.liveScoringConfig || event.live_scoring_config || null;
  if (raw && typeof raw === "object") {
    return {
      groupFormat: event.play_format === "doubles" || raw.groupFormat === "doubles" ? "doubles" : "singles",
      scoringStyle: raw.scoringStyle === "matchplay" ? "matchplay" : "stroke",
    };
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      return registrationLiveConfig({ ...event, liveScoringConfig: JSON.parse(raw), live_scoring_config: null });
    } catch {
      return { groupFormat: event.play_format === "doubles" ? "doubles" : "singles", scoringStyle: "stroke" };
    }
  }
  if (raw == null && event.play_format === "doubles") return { groupFormat: "doubles", scoringStyle: event.format === "matchplay" ? "matchplay" : "stroke" };
  return { groupFormat: "singles", scoringStyle: event.format === "matchplay" ? "matchplay" : "stroke" };
}

export function isDoublesRegistration(event) {
  return registrationLiveConfig(event).groupFormat === "doubles";
}

export function clientOwed(event, addons) {
  let total = event.entry_fee_cents || 0;
  if (addons?.ctp && event.ctp_fee_cents) total += event.ctp_fee_cents;
  if (addons?.ace && event.ace_fee_cents) total += event.ace_fee_cents;
  return total;
}

export function eventMeta(event) {
  const layout = event.layout_name ? `${event.layout_name}${event.total_par != null ? ` - par ${event.total_par}` : ""}` : null;
  return [event.course_name, layout].filter(Boolean).join(" - ");
}

export function sortRegistrations(rows) {
  const statusRank = (status) => (status === "live" ? 0 : status === "scheduled" ? 1 : 2);
  return rows.slice().sort((a, b) => {
    const rankA = statusRank(a.event_status);
    const rankB = statusRank(b.event_status);
    if (rankA !== rankB) return rankA - rankB;
    const dateA = a.event_date || "";
    const dateB = b.event_date || "";
    return rankA === 1 ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA);
  });
}

export function pickUpNext(events, registrations) {
  const open = Array.isArray(events) ? events : [];
  const rows = Array.isArray(registrations) ? registrations : [];
  const byId = new Map(open.map((event) => [String(event.id), event]));
  const upcoming = sortRegistrations(rows).filter((row) => row.event_status === "live" || row.event_status === "scheduled");
  if (upcoming[0]) {
    const row = upcoming[0];
    return { event: byId.get(String(row.event_id)) || eventFromRegistration(row), registration: row };
  }
  const event = open[0] || null;
  if (!event) return { event: null, registration: null };
  return { event, registration: rows.find((row) => String(row.event_id) === String(event.id)) || null };
}

export function localDateTimeValue(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
