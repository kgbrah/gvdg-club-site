// Registration for a club-run PDGA event, on the event page (the link the TD puts on the PDGA event): the PDGA
// event, its published rules and cap, the paid field and the waitlist (PDGA Competition Manual 1.02.7), sign-up with
// a PDGA number checked by PDGA, and payment by PayPal or Zelle with an optional gift to the club instead of Disc Golf
// Scene's fee. Player, event and course data from PDGA carry PDGA's credit and link to pdga.com.
import React from "react";
import { publicApiBase } from "./public-api.js";
import { clearMemberSession, readMemberToken } from "../shared/member-session.js";
import { guestRegs, setGuestReg } from "./guest-registrations.js";
import { PdgaCredit, PdgaLink, pdgaPlayerHref } from "../shared/pdga-credit.js";
import { formatPdgaTier, isAmateurDivision } from "../shared/pdga-divisions.js";
import { parseArray } from "../members-app/registration-utils.js";
import { SIGNUP_LINK } from "../shared/outside-link.js";

const h = React.createElement;
const REFUND_POLICY_URL = "https://www.pdga.com/rules/competition-manual/103";
let paypalSdk = null;

function dollars(cents) {
  return "$" + ((Math.round(Number(cents) || 0)) / 100).toFixed(2);
}

function loadPaypalSdk(clientId) {
  if (window.paypal) return Promise.resolve();
  if (paypalSdk) return paypalSdk;
  paypalSdk = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
    script.onload = resolve;
    script.onerror = () => { paypalSdk = null; reject(new Error("paypal_sdk_load_failed")); };
    document.head.appendChild(script);
  });
  return paypalSdk;
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch(publicApiBase() + path, { method, headers, cache: "no-store", body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

const ERRORS = {
  division_rating_limit: (data) => `Your PDGA rating (${data.rating}) is above this division's limit of ${data.limit}. Choose another division.`,
  pdga_rating_unverified: (data) => `This division requires a rating check (${data.limit} or below). Renew your PDGA membership or pick an open division.`,
  pro_in_amateur_division: (data) => data.limit != null
    ? `Players classed Pro may play Amateur divisions only when rated ${data.limit} or below (yours: ${data.rating ?? "unrated"}).`
    : "This Amateur division isn't open to Professional-class players at this tier.",
  pdga_membership_required: () => "This event is for current PDGA members. Renew at pdga.com, then register.",
  pdga_check_required: () => "This event is for current PDGA members: enter your PDGA number.",
  pdga_not_found: () => "PDGA has no player with that number. Check it and try again.",
  pdga_unavailable: () => "PDGA couldn't be reached to check your number. Try again in a few minutes.",
  invalid_pdga_number: () => "Enter your PDGA number (digits only).",
  name_required: () => "Enter your name.",
  division_required: () => "Choose a division.",
  registration_closed: () => "Registration is closed.",
  field_full: () => "The field filled before your payment went through, so you weren't charged. You're on the waitlist.",
  waitlisted: () => "You're on the waitlist. If a spot opens, the TD will offer it to you here.",
  offer_expired: () => "Your 48-hour spot offer expired. If another spot opens, the TD can offer it to the waitlist.",
  wallet_not_allowed_for_tournament: () => "Store credit can't be used for PDGA tournament entries. Pay by PayPal or Zelle.",
  already_paid: () => "Your entry is already paid.",
  paid_contact_admin: () => "You have already paid. Contact the Tournament Director to withdraw.",
  event_started: () => "The event has started or finished, so you can't withdraw online. Contact the Tournament Director.",
  rate_limited: () => "Too many tries. Wait a minute and try again.",
  session_expired: () => "Your members session expired. Sign in again, or register as a guest.",
};
const errorText = (data) => (ERRORS[data && data.error] || (() => "That didn't work. Try again."))(data || {});

function useTournament(eventId) {
  const [state, setState] = React.useState({ status: "loading", data: null });
  const [token, setToken] = React.useState(() => readMemberToken() || null);
  const guest = token ? null : guestRegs()[eventId] || null;
  const load = React.useCallback(async (overrideToken) => {
    const activeToken = overrideToken !== undefined ? overrideToken : (readMemberToken() || null);
    if (activeToken !== token) setToken(activeToken);
    const activeGuest = activeToken ? null : guestRegs()[eventId] || null;
    const query = activeGuest && activeGuest.guestToken ? `?gt=${encodeURIComponent(activeGuest.guestToken)}` : "";
    let result = await api(`/events/${encodeURIComponent(eventId)}/registration${query}`, { token: activeToken });
    if (activeToken && (result.status === 401 || result.data?.error === "session_expired")) {
      clearMemberSession();
      setToken(null);
      const guestFallback = guestRegs()[eventId] || null;
      const fallbackQuery = guestFallback && guestFallback.guestToken ? `?gt=${encodeURIComponent(guestFallback.guestToken)}` : "";
      result = await api(`/events/${encodeURIComponent(eventId)}/registration${fallbackQuery}`);
    }
    setState(result.ok && result.data.tournament ? { status: "ready", data: result.data } : { status: "error", data: null });
  }, [eventId, token]);
  React.useEffect(() => { load(); }, [load]);
  return { ...state, load, token, guest };
}

function Rules({ tournament, config }) {
  const rules = tournament.rules || {};
  const limits = Object.entries(rules.divisionLimits || {});
  const items = [
    config.entry_fee_cents ? `Entry ${dollars(config.entry_fee_cents)}` : null,
    rules.nonMemberFeeCents ? `${dollars(rules.nonMemberFeeCents)} added for players who aren't current PDGA members` : null,
    rules.membersOnly ? "Current PDGA members only" : null,
    ...limits.map(([division, limit]) => `${division}: rated ${limit} or below`),
    tournament.cap ? `Field capped at ${tournament.cap} players${tournament.spotsLeft != null ? ` (${tournament.spotsLeft} left)` : ""}; then a waitlist` : null,
    "You're entered when your entry fee is received; the field fills in that order",
  ].filter(Boolean);
  return h("ul", { className: "tournament-rules" }, items.map((text) => h("li", { key: text }, text)));
}

function FieldLists({ tournament }) {
  return h("div", { className: "tournament-field" }, [
    h("h3", { className: "roster-title", key: "field-title" }, `Registered (${tournament.field.length}${tournament.cap ? ` of ${tournament.cap}` : ""})`),
    tournament.field.length
      ? h("ol", { className: "tournament-list", key: "field" }, tournament.field.map((row, index) =>
        h("li", { key: index }, row.division ? `${row.name} · ${row.division}` : row.name)))
      : h("p", { className: "dash-note", key: "none" }, "No paid registrations yet."),
    tournament.waitlist.length ? h("h3", { className: "roster-title", key: "wait-title" }, `Waitlist (${tournament.waitlist.length})`) : null,
    tournament.waitlist.length
      ? h("ol", { className: "tournament-list", key: "wait" }, tournament.waitlist.map((row) =>
        h("li", { key: row.position }, row.division ? `${row.name} · ${row.division}` : row.name)))
      : null,
  ]);
}

function RenewHint({ token }) {
  const [promo, setPromo] = React.useState(null);
  React.useEffect(() => {
    if (!token) return undefined;
    let live = true;
    api("/pdga/membership", { token }).then((result) => { if (live && result.ok) setPromo(result.data.promo || null); });
    return () => { live = false; };
  }, [token]);
  return h("p", { className: "tournament-renew", "data-pdga-renew": "" }, [
    h("a", { href: "https://www.pdga.com/membership/renew", ...SIGNUP_LINK, key: "renew" }, "Renew with PDGA"),
    promo ? [" with the club's code ", h("b", { key: "code" }, promo.code), " ($5 off)."]
      : " (GVDG members get $5 off with the club's code: sign in to see it).",
  ]);
}

function PlayerCheck({ player, token }) {
  if (!player) return null;
  const membership = player.membershipStatus === "current"
    ? `current PDGA member${player.membershipExpires ? ` through ${player.membershipExpires}` : ""}`
    : `PDGA membership ${player.membershipStatus}`;
  return h("div", { className: "tournament-player", "data-pdga-player": player.pdgaNumber }, [
    h(PdgaLink, { href: pdgaPlayerHref(player.pdgaNumber), key: "name" }, `${player.name} #${player.pdgaNumber}`),
    ` · ${membership}${player.rating ? ` · rated ${player.rating}` : " · unrated"}`,
    player.membershipStatus !== "current" ? h(RenewHint, { token, key: "renew" }) : null,
  ]);
}

function SignUp({ event, config, tournament, token, onDone, onSessionExpired }) {
  const divisions = parseArray(config.divisions);
  const [pdgaNumber, setPdgaNumber] = React.useState("");
  const [player, setPlayer] = React.useState(null);
  const [division, setDivision] = React.useState(divisions[0] || "");
  const [name, setName] = React.useState("");
  const [nameTyped, setNameTyped] = React.useState(false); // filled from PDGA until the player types their own
  const [email, setEmail] = React.useState("");
  const [addons, setAddons] = React.useState({ ctp: false, ace: false });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const limits = (tournament.rules && tournament.rules.divisionLimits) || {};
  const tier = String((tournament.pdgaEvent && tournament.pdgaEvent.tier) || "").trim().toUpperCase();

  const divisionBlocked = (div, currentPlayer = player) => {
    if (!currentPlayer) return false;
    const limit = limits[div];
    if (currentPlayer.rating != null && limit != null && currentPlayer.rating > limit) return true;
    if (currentPlayer.rating == null && currentPlayer.membershipStatus !== "current" && limit != null) return true;
    if (currentPlayer.classification === "P" && isAmateurDivision(div)) {
      if (["M", "ES", "NT", "XM"].includes(tier)) return true;
      const proCap = /^F/i.test(String(div || "").trim()) ? 870 : 970;
      if (currentPlayer.rating == null || currentPlayer.rating >= proCap) return true;
    }
    return false;
  };

  async function check() {
    setError("");
    setPlayer(null);
    if (!pdgaNumber.trim()) return;
    const result = await api(`/pdga/player?number=${encodeURIComponent(pdgaNumber.trim())}`);
    if (!result.ok) { setError(errorText(result.data)); return; }
    if (!result.data.player) { setError(errorText({ error: "pdga_not_found" })); return; }
    const nextPlayer = result.data.player;
    setPlayer(nextPlayer);
    if (!nameTyped || !name) setName(nextPlayer.name);
    if (division && divisionBlocked(division, nextPlayer)) {
      const allowed = divisions.find((div) => !divisionBlocked(div, nextPlayer));
      if (allowed) setDivision(allowed);
    }
  }

  async function submit(formEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api(`/events/${encodeURIComponent(event.id)}/register`, {
        method: "POST", token,
        body: { pdgaNumber: pdgaNumber.trim() || undefined, division, name: token ? undefined : name, email: token ? undefined : email, addons },
      });
      if (!result.ok) {
        if (result.status === 401 || result.data?.error === "session_expired") {
          clearMemberSession();
          if (onSessionExpired) onSessionExpired();
        }
        setError(errorText(result.data));
        return;
      }
      if (result.data.guestToken) setGuestReg(event.id, { guestToken: result.data.guestToken, name: result.data.registration.name });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const overLimit = (div) => divisionBlocked(div);
  return h("form", { className: "tournament-signup", onSubmit: submit }, [
    h("label", { key: "pdga" }, [
      "PDGA number",
      h("span", { className: "tournament-inline", key: "row" }, [
        h("input", { key: "input", inputMode: "numeric", autoComplete: "off", value: pdgaNumber, placeholder: token ? "Leave blank to use your profile's" : "e.g. 80024",
          onChange: (e) => { setPdgaNumber(e.target.value.replace(/[^\d]/g, "")); setPlayer(null); }, onBlur: check }),
        h("button", { className: "reg-btn tertiary", type: "button", key: "check", onClick: check }, "Check"),
      ]),
    ]),
    h(PlayerCheck, { player, token, key: "player" }),
    divisions.length ? h("label", { key: "division" }, ["Division", h("select", { key: "select", value: division, onChange: (e) => setDivision(e.target.value) },
      divisions.map((div) => h("option", { key: div, value: div, disabled: overLimit(div) }, limits[div] != null ? `${div} (rated ${limits[div]} or below)` : div)))]) : null,
    token ? null : h("label", { key: "name" }, ["Name", h("input", { key: "input", value: name, autoComplete: "name",
      onChange: (e) => { setName(e.target.value); setNameTyped(true); } })]),
    token ? null : h("label", { key: "email" }, ["Email (for your confirmation)", h("input", { key: "input", type: "email", value: email, autoComplete: "email", onChange: (e) => setEmail(e.target.value) })]),
    config.ctp_fee_cents ? h("label", { className: "tournament-check", key: "ctp" }, [
      h("input", { key: "box", type: "checkbox", checked: addons.ctp, onChange: (e) => setAddons({ ...addons, ctp: e.target.checked }) }), ` CTP pot (${dollars(config.ctp_fee_cents)})`]) : null,
    config.ace_fee_cents ? h("label", { className: "tournament-check", key: "ace" }, [
      h("input", { key: "box", type: "checkbox", checked: addons.ace, onChange: (e) => setAddons({ ...addons, ace: e.target.checked }) }), ` Ace pot (${dollars(config.ace_fee_cents)})`]) : null,
    error ? h("p", { className: "register-error", role: "alert", key: "error" }, error) : null,
    h("button", { className: "reg-btn", type: "submit", disabled: busy, key: "submit" }, busy ? "Registering…" : "Register"),
  ]);
}

function Quote({ quote }) {
  if (!quote) return null;
  const lines = [
    ["Entry", quote.owedCents],
    quote.feeCents ? ["PayPal's fee", quote.feeCents] : null,
    quote.donationCents ? ["Gift to the club", quote.donationCents] : null,
  ].filter(Boolean);
  return h("dl", { className: "tournament-quote" }, [
    ...lines.flatMap(([label, cents]) => [h("dt", { key: label + "t" }, label), h("dd", { key: label + "d" }, dollars(cents))]),
    h("dt", { key: "tt" }, h("b", null, "Total")), h("dd", { key: "td" }, h("b", null, dollars(quote.totalCents))),
  ]);
}

function Payment({ event, tournament, registration, token, guest, onDone }) {
  const zelle = tournament.payments && tournament.payments.zelle;
  const [method, setMethod] = React.useState(registration.payment_method === "zelle" && zelle ? "zelle" : "paypal");
  const [donate, setDonate] = React.useState(Number(registration.donation_cents) > 0);
  const [donateDirty, setDonateDirty] = React.useState(false);
  const [quote, setQuote] = React.useState(null);
  const [zelleInfo, setZelleInfo] = React.useState(null);
  const [error, setError] = React.useState("");
  const paypalHost = React.useRef(null);
  const guestToken = guest && guest.guestToken;
  const gt = guestToken ? `&gt=${encodeURIComponent(guestToken)}` : "";
  const base = `/events/${encodeURIComponent(event.id)}/pay`;

  React.useEffect(() => {
    let live = true;
    api(`${base}/quote?method=${method}&donate=${donate ? 1 : 0}${gt}`, { token }).then((result) => { if (live && result.ok) setQuote(result.data.quote); });
    return () => { live = false; };
  }, [base, gt, token, method, donate]);

  React.useEffect(() => {
    if (method !== "paypal" || !paypalHost.current) return undefined;
    let live = true;
    const host = paypalHost.current;
    host.replaceChildren();
    api("/payments/config").then(async (config) => {
      if (!live || !config.data.enabled) { if (live) setError("Online payment isn't available right now."); return; }
      await loadPaypalSdk(config.data.clientId);
      if (!live || !window.paypal) return;
      window.paypal.Buttons({
        createOrder: async () => {
          const result = await api(`${base}/create-order`, { method: "POST", token, body: { guestToken, donate } });
          if (!result.ok) {
            setError(errorText(result.data));
            if (result.data?.error === "field_full" || result.data?.error === "offer_expired") onDone();
            throw new Error(result.data?.error || "order");
          }
          return result.data.orderId;
        },
        onApprove: async (data) => {
          const result = await api(`${base}/capture`, { method: "POST", token, body: { guestToken, orderId: data.orderID } });
          if (!result.ok) setError(errorText(result.data));
          onDone();
        },
        onError: () => setError("PayPal didn't finish. You haven't been charged; try again."),
      }).render(host);
    }).catch(() => setError("PayPal couldn't load. Try again in a moment."));
    return () => { live = false; host.replaceChildren(); };
  }, [base, guestToken, token, method, donate]);

  async function chooseZelle() {
    setError("");
    const result = await api(`${base}/zelle`, { method: "POST", token, body: { guestToken, donate } });
    if (!result.ok) {
      setError(errorText(result.data));
      if (result.data?.error === "field_full" || result.data?.error === "offer_expired") onDone();
      return;
    }
    setDonateDirty(false);
    setZelleInfo(result.data.zelle);
  }

  async function sent() {
    const result = await api(`${base}/zelle/sent`, { method: "POST", token, body: { guestToken } });
    if (!result.ok) setError(errorText(result.data));
    onDone();
  }

  const saved = quote ? quote.savedVsDgsCents : 0;
  const shownZelle = zelleInfo || (!donateDirty && registration.payment_method === "zelle" && registration.zelle_code && zelle && quote
    ? { to: zelle.to, name: zelle.name ?? null, amountCents: quote.totalCents, memo: registration.zelle_code }
    : null);
  return h("div", { className: "tournament-pay" }, [
    h("h3", { className: "roster-title", key: "title" }, "Pay your entry"),
    h("div", { className: "tournament-methods", role: "radiogroup", "aria-label": "Payment method", key: "methods" }, [
      h("label", { key: "paypal" }, [h("input", { key: "r", type: "radio", name: "method", checked: method === "paypal", onChange: () => { setError(""); setMethod("paypal"); } }),
        tournament.payments.paypalFeeCovered ? " PayPal or card (PayPal's fee added)" : " PayPal or card"]),
      zelle ? h("label", { key: "zelle" }, [h("input", { key: "r", type: "radio", name: "method", checked: method === "zelle", onChange: () => { setError(""); setMethod("zelle"); } }), " Zelle (no fee)"]) : null,
    ]),
    saved > 0 ? h("label", { className: "tournament-check", key: "donate" }, [
      h("input", { key: "box", type: "checkbox", checked: donate, onChange: (e) => { setZelleInfo(null); setDonateDirty(true); setDonate(e.target.checked); } }),
      ` Give the club the ${dollars(saved)} you're saving vs Disc Golf Scene`]) : null,
    h(Quote, { quote, key: "quote" }),
    error ? h("p", { className: "register-error", role: "alert", key: "error" }, error) : null,
    method === "paypal" ? h("div", { className: "tournament-paypal", ref: paypalHost, key: "paypal" }) : null,
    method === "zelle" && !shownZelle ? h("button", { className: "reg-btn", type: "button", key: "zelle", onClick: chooseZelle }, "Pay with Zelle") : null,
    method === "zelle" && shownZelle ? h("div", { className: "tournament-zelle", key: "zelle-info" }, [
      h("p", { key: "to" }, ["Send ", h("b", { key: "a" }, dollars(shownZelle.amountCents)), " by Zelle to ", h("b", { key: "t" }, shownZelle.to),
        shownZelle.name ? ` (${shownZelle.name})` : "", ", with this memo: ", h("b", { key: "m" }, shownZelle.memo)]),
      h("p", { className: "dash-note", key: "note" }, "You're entered once the club sees it arrive. Spots go in the order payments arrive."),
      registration.zelle_sent_at
        ? h("p", { className: "dash-note", key: "sent" }, "Thanks, the TD will confirm it.")
        : h("button", { className: "reg-btn secondary", type: "button", key: "sent", onClick: sent }, "I've sent it"),
    ]) : null,
  ]);
}

function Withdraw({ event, tournament, registration, token, guest, onDone }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  if (Number(registration.paid_entry) === 1) {
    // PDGA 1.03.1: withdrawals go to the Tournament Director (by email or phone).
    return tournament.tdEmail
      ? h("a", { className: "reg-btn secondary", href: `mailto:${tournament.tdEmail}?subject=${encodeURIComponent(`Withdraw: ${event.name}`)}&body=${encodeURIComponent(`Please withdraw ${registration.name}${registration.division ? ` (${registration.division})` : ""} from ${event.name}.`)}` },
        "Email the TD to withdraw")
      : h("p", { className: "dash-note" }, "To withdraw, contact the Tournament Director.");
  }
  async function withdraw() {
    setBusy(true);
    setError("");
    try {
      const query = guest && guest.guestToken ? `?gt=${encodeURIComponent(guest.guestToken)}` : "";
      const result = await api(`/events/${encodeURIComponent(event.id)}/register${query}`, { method: "DELETE", token });
      if (!result.ok) { setError(errorText(result.data)); return; }
      if (guest) setGuestReg(event.id, null);
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return h(React.Fragment, null, [
    error ? h("p", { className: "register-error", role: "alert", key: "error" }, error) : null,
    h("button", { className: "reg-btn tertiary", type: "button", key: "btn", disabled: busy, onClick: withdraw }, busy ? "Withdrawing…" : "Withdraw"),
  ]);
}

export function TournamentRegistration({ event, onChanged }) {
  const state = useTournament(event.id);
  const reload = React.useCallback(() => { state.load(); if (onChanged) onChanged(); }, [state.load, onChanged]);
  if (state.status !== "ready") return null;
  const { config, registration, tournament } = state.data;
  const pdgaEvent = tournament.pdgaEvent || {};
  const tierLabel = formatPdgaTier(pdgaEvent.tier);
  const paid = registration && Number(registration.paid_entry) === 1;
  const waitlisted = registration && Number(registration.waitlisted) === 1;
  const offerExpired = Boolean(tournament.offerExpired);
  const registrationOpen = Number(config?.registration_open) === 1 && event.status !== "final" && event.status !== "cancelled";
  const position = waitlisted ? tournament.myWaitlistPosition || 0 : 0;
  return h("section", { className: "event-register-panel tournament-register", "data-tournament-registration": paid ? "paid" : waitlisted ? "waitlisted" : registration ? "registered" : registrationOpen ? "open" : "closed" }, [
    h("h2", { className: "roster-title", key: "title" }, "Register"),
    h("p", { className: "tournament-pdga", key: "pdga" }, [
      "PDGA event: ",
      h(PdgaLink, { href: tournament.pdgaEventUrl, key: "link" }, pdgaEvent.name || `#${tournament.pdgaEventId}`),
      tierLabel ? ` · ${tierLabel}` : "",
    ]),
    h(Rules, { tournament, config, key: "rules" }),
    !registration && registrationOpen
      ? h(SignUp, { event, config, tournament, token: state.token, onDone: reload, onSessionExpired: () => state.load(null), key: "signup" })
      : null,
    !registration && !registrationOpen
      ? h("p", { className: "dash-note", key: "closed" }, "Registration is closed.")
      : null,
    registration ? h("p", { className: "register-status", key: "status" },
      paid ? `You're entered${registration.division ? ` in ${registration.division}` : ""}.`
        : waitlisted ? `You're on the waitlist${position ? ` (#${position})` : ""}. If a spot opens, the TD will offer it to you here.`
          : offerExpired ? "Your 48-hour spot offer expired."
            : registration.offered_at ? "A spot opened for you: pay below to take it (held for 48 hours)."
              : "You're signed up. Pay your entry to take a spot in the field.") : null,
    registration && !paid && !waitlisted && !offerExpired ? h(Payment, { event, tournament, registration, token: state.token, guest: state.guest, onDone: reload, key: "pay" }) : null,
    registration ? h(Withdraw, { event, tournament, registration, token: state.token, guest: state.guest, onDone: reload, key: "withdraw" }) : null,
    h(FieldLists, { tournament, key: "field" }),
    h("p", { className: "dash-note", key: "refunds" }, [
      "Withdrawals and refunds follow the PDGA's ",
      h("a", { href: REFUND_POLICY_URL, target: "_blank", rel: "noopener noreferrer", key: "link" }, "standard policy"),
      tournament.tdEmail ? ["; withdraw by emailing the TD at ", h("a", { href: `mailto:${tournament.tdEmail}`, key: "td" }, tournament.tdEmail)] : "",
      ".",
    ]),
    h(PdgaCredit, { key: "credit" }),
  ]);
}
