import React from "react";
import { KarmaChip } from "../shared/karma.js";
import { request, requestJson } from "./api.js";
import { readMemberToken, TOKEN_KEY } from "../shared/member-session.js";
import { memberConfirm } from "./member-dialogs.js";
import { useMemberContext } from "./member-context.js";
import { PdgaCredit, PdgaLink, pdgaPlayerHref, pdgaPlayerStatsHref } from "../shared/pdga-credit.js";
import { formatPdgaAnnualSummary } from "./pdga-dashboard.js";
import { AutocompleteInput } from "../shared/autocomplete.js";

const h = React.createElement;
const AUDIENCES = [
  ["private", "Private"], ["friends", "Friends"], ["club", "Club members"], ["public", "Public"],
];

export async function communityRequest(path, options = {}) {
  const response = await request(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || "unavailable");
    error.status = response.status;
    throw error;
  }
  return data;
}

export function sharedProfileHref(key, base = typeof location === "undefined" ? "https://gvdgclub.com/gvdg-members.html" : location.href) {
  const url = new URL("gvdg-members.html", base);
  url.searchParams.set("profile", key);
  return url.href;
}

function action(label, attrs = {}) {
  return h("button", { className: "dashboard-action", type: "button", ...attrs }, label);
}

function note(text, key = "note") {
  return text ? h("p", { className: "dash-note", role: "status", key }, text) : null;
}

function field(label, element, props) {
  return h("label", { className: "community-field", key: props.name }, [
    h("span", { key: "label" }, label), h(element, { className: "form-input", key: "input", ...props }),
  ]);
}

function ProfilePreview({ profile }) {
  const [pdgaState, setPdgaState] = React.useState({ status: "idle", stats: null });

  React.useEffect(() => {
    setPdgaState({ status: "idle", stats: null });
  }, [profile.key, profile.pdgaNo]);

  async function loadPdga() {
    if (!profile.pdgaNo || pdgaState.status === "loading") return;
    setPdgaState({ status: "loading", stats: null });
    try {
      const stats = await requestJson(`/pdga-stats?pdga=${encodeURIComponent(profile.pdgaNo)}`);
      setPdgaState({ status: "ready", stats });
    } catch {
      setPdgaState({ status: "error", stats: null });
    }
  }

  const stats = pdgaState.stats;
  const topAnnual = Array.isArray(stats?.annual_stats) ? stats.annual_stats[0] : null;
  const topAnnualSummary = topAnnual ? formatPdgaAnnualSummary(topAnnual).join(" · ") : "";

  return [
    h("h1", { className: "section-title", key: "name" }, [profile.displayName || "Club member", h(KarmaChip, { karmaKey: profile.karmaKey, key: "karma" })]),
    profile.bio ? h("p", { className: "community-body", key: "bio" }, profile.bio) : null,
    profile.progress ? h("p", { className: "dash-note", key: "progress" },
      profile.progress.total + " completed GVDG rounds") : null,
    profile.pdgaNo ? h("div", { className: "community-pdga-card", key: "pdga" }, [
      h("div", { className: "community-pdga-head", key: "head" }, [
        h(PdgaLink, { href: pdgaPlayerHref(profile.pdgaNo), key: "link" }, `PDGA #${profile.pdgaNo}`),
        pdgaState.status === "idle" || pdgaState.status === "error"
          ? action("Load PDGA stats", {
            className: "dashboard-action",
            "data-profile-load-pdga": "true",
            key: "load",
            onClick: () => { void loadPdga(); },
          })
          : null,
      ].filter(Boolean)),
      pdgaState.status === "loading" ? note("Loading official PDGA stats…", "pdga-loading") : null,
      pdgaState.status === "error" ? note("Could not load PDGA stats right now.", "pdga-error") : null,
      pdgaState.status === "ready" && stats ? h("div", { className: "community-pdga-body", key: "body" }, [
        stats.official_rating != null
          ? h("p", { className: "community-body", key: "official" }, `Official rating: ${stats.official_rating}${stats.rating_date ? ` (${stats.rating_date})` : ""}`)
          : h("p", { className: "dash-note", key: "official" }, "Official PDGA rating is unavailable."),
        stats.live_rating != null
          ? h("p", { className: "dash-note", key: "live" }, `Recent Live rating estimate: ${stats.live_rating}`)
          : null,
        topAnnual ? h("p", { className: "dash-note", key: "annual" }, [
          `${topAnnual.year} ${topAnnual.divisionCode}`,
          topAnnualSummary ? `: ${topAnnualSummary}` : "",
          " · ",
          h("a", { className: "pdga-link", href: topAnnual.url || pdgaPlayerStatsHref(profile.pdgaNo, topAnnual.year), rel: "noopener noreferrer", target: "_blank", key: "yr" }, "PDGA.com"),
        ]) : null,
        h(PdgaCredit, { key: "credit" }),
      ].filter(Boolean)) : null,
    ].filter(Boolean)) : null,
  ].filter(Boolean);
}

export function PublicCommunityProfile({ profileKey }) {
  const [state, setState] = React.useState({ pending: true, profile: null });
  React.useEffect(() => {
    let controller;
    function load() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const token = readMemberToken();
      setState({ pending: true, profile: null });
      communityRequest("/community/profiles/" + encodeURIComponent(profileKey), { token, signal: request.signal })
        .then(({ profile }) => {
          if (request.signal.aborted || readMemberToken() !== token) return;
          document.title = (profile.displayName || "Club member") + " | GVDG";
          setState({ pending: false, profile });
        })
        .catch(() => {
          if (!request.signal.aborted) {
            document.title = "Profile unavailable | GVDG";
            setState({ pending: false, profile: null });
          }
        });
    }
    const restored = (event) => { if (event.persisted) load(); };
    load();
    window.addEventListener("pageshow", restored);
    const accountChanged = (event) => { if (event.key === TOKEN_KEY) load(); };
    window.addEventListener("storage", accountChanged);
    return () => {
      controller?.abort();
      window.removeEventListener("pageshow", restored);
      window.removeEventListener("storage", accountChanged);
    };
  }, [profileKey]);
  return h("section", { className: "login-gate", "aria-label": "Shared member profile" },
    h("div", { className: "login-card community-shared-profile" }, [
      state.profile ? h(ProfilePreview, { profile: state.profile, key: "preview" }) : h("h1", { className: "login-title", key: "title" }, state.pending ? "Loading profile…" : "Profile unavailable"),
      h("a", { className: "dashboard-action", href: "gvdg-members.html#community", key: "members" }, "Open the member app"),
    ]));
}

function ProfileSettings({ initial, save }) {
  const { pdgaNo } = useMemberContext();
  const [form, setForm] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const link = initial.audience === "public" && initial.key ? sharedProfileHref(initial.key) : null;

  function change(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setMessage("");
  }

  async function submit(event) {
    event.preventDefault();
    if (form.audience !== "private" && !form.displayName.trim()) { setMessage("Enter the name you want people to see."); return; }
    setBusy(true);
    try {
      const updated = await save({
        audience: form.audience,
        displayName: form.displayName,
        bio: form.bio,
        shareProgress: form.audience !== "private" && form.shareProgress,
        sharePdga: form.audience !== "private" && Boolean(form.sharePdga),
        revision: initial.revision,
      });
      if (updated) setForm(updated);
      setMessage("Profile settings saved.");
    } catch (error) {
      setMessage(error.status === 409 ? "This profile changed in another tab. Reload before saving." : "Profile settings couldn’t be saved.");
    } finally { setBusy(false); }
  }

  return h("form", { className: "player-card community-form member-community-profile", onSubmit: submit }, [
    h("h2", { key: "title" }, "Edit community profile"),
    h("label", { className: "community-field", key: "audience" }, [
      "Who can see your profile?",
      h("select", { className: "form-input", value: form.audience, key: "select", onChange: (event) => change("audience", event.target.value) },
        AUDIENCES.map(([value, label]) => h("option", { value, key: value }, label))),
    ]),
    initial.audience === "public" && form.audience !== "public" ? note("Saving this change disables the current public link.", "revoke") : null,
    note(form.audience === "private" ? "Only you can see your profile." : form.audience === "friends"
      ? "Accepted friends can see this profile. Members you send a request to will see your display name."
      : form.audience === "club" ? "Signed-in club members can find this profile in the directory."
        : "Anyone with the link can open your profile. Signed-in members can find it in the directory.", "privacy"),
    field("Display name", "input", { name: "displayName", maxLength: 60, required: form.audience !== "private", value: form.displayName,
      onChange: (event) => change("displayName", event.target.value) }),
    field("About me", "textarea", { name: "bio", maxLength: 300, rows: 3, value: form.bio, onChange: (event) => change("bio", event.target.value) }),
    h("label", { key: "progress" }, [
      h("input", { type: "checkbox", key: "check", checked: form.audience !== "private" && form.shareProgress,
        disabled: form.audience === "private", onChange: (event) => change("shareProgress", event.target.checked) }),
      " Share my total completed GVDG rounds with this audience",
    ]),
    h("label", { key: "pdga" }, [
      h("input", { type: "checkbox", key: "check", checked: form.audience !== "private" && Boolean(form.sharePdga),
        disabled: form.audience === "private" || !pdgaNo, onChange: (event) => change("sharePdga", event.target.checked) }),
      pdgaNo ? ` Share my PDGA # (#${pdgaNo}) so viewers can load my PDGA stats on demand` : " Share my PDGA # (link your PDGA # in Account settings first)",
    ]),
    h("div", { className: "dashboard-actions", key: "actions" }, [
      action(busy ? "Saving…" : "Save profile settings", { key: "save", type: "submit", className: "dashboard-action primary", disabled: busy }),
      link ? action("Copy public profile link", { key: "copy", onClick: async () => {
        try { await navigator.clipboard.writeText(link); setMessage("Public profile link copied."); }
        catch { setMessage("Open your public profile to copy the link."); }
      } }) : null,
      link ? h("a", { className: "dashboard-action", href: link, key: "link" }, "Open public profile") : null,
    ]),
    note(message),
  ]);
}

function PrivateProgress({ progress }) {
  const total = progress.totals.club + progress.totals.casual;
  const peak = Math.max(1, ...progress.weekly.map((row) => row.rounds));
  return h("section", { className: "player-card member-community-progress", "aria-label": "Your progress", key: "progress" }, [
    h("h2", { key: "title" }, "Your progress"),
    h("p", { key: "total" }, total + " completed rounds · " + progress.totals.club + " club · " + progress.totals.casual + " casual"),
    h("p", { key: "streak" }, progress.streak ? (progress.streakCapped ? "52+" : String(progress.streak))
      + (progress.streak === 1 ? " week played in a row" : " weeks played in a row") : "No current weekly streak"),
    h("p", { className: "player-card-meta", key: "basis" }, "Based on completed rounds recorded by GVDG. Weeks start on Monday in Eastern time. A streak can continue through the current week."),
    progress.achieved.length ? h("p", { className: "community-body", key: "milestones" }, "Milestones reached · " + progress.achieved.map((value) => value === 1 ? "First round" : value + " rounds").join(" · ")) : null,
    progress.next ? h("p", { className: "player-card-meta", key: "next" }, "Next milestone · " + progress.next + (progress.next === 1 ? " completed round" : " completed rounds")) : null,
    h("details", { key: "weeks" }, [
      h("summary", { key: "label" }, "Last eight weeks"),
      h("ul", { className: "community-list", key: "items" }, progress.weekly.map(({ startsOn, rounds }) => h("li", { className: "community-week", key: startsOn }, [
        h("time", { dateTime: startsOn, key: "date" }, startsOn),
        h("progress", { "aria-label": "Rounds in week of " + startsOn, max: peak, value: rounds, key: "bar" }),
        h("span", { key: "rounds" }, rounds + (rounds === 1 ? " round" : " rounds")),
      ]))),
    ]),
  ]);
}

function connectionAction(label, key, pending, update, attrs = {}) {
  return action(label, { key, disabled: pending, onClick: () => { void update(key); }, ...attrs });
}

const KEYBOARD_CLASS = "member-keyboard-open";

// The page uses interactive-widget=overlays-content, so the on-screen keyboard covers the layout
// instead of resizing it. Hide the fixed dock while the field is focused and keep the field and
// its results in the visible viewport.
function useKeyboardSafeSearch(ref) {
  React.useEffect(() => {
    const root = document.documentElement;
    let timer = 0;
    const reveal = () => {
      const input = ref.current;
      if (!input || document.activeElement !== input) return;
      // The keyboard overlays the page (interactive-widget=overlays-content), so "center" can still land under it.
      // Put the search form just below the sticky header instead, inside the visible viewport.
      const target = input.closest("form") || input;
      const header = document.querySelector(".member-app-header, header");
      const headerBottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
      const top = (window.visualViewport?.offsetTop || 0) + headerBottom + 12;
      const delta = target.getBoundingClientRect().top - top;
      if (Math.abs(delta) > 4) window.scrollBy({ top: delta, behavior: "auto" });
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { reveal(); timer = setTimeout(reveal, 300); }, 120); };
    const focus = (event) => { if (event.target === ref.current) { root.classList.add(KEYBOARD_CLASS); schedule(); } };
    const blur = (event) => { if (event.target === ref.current) { root.classList.remove(KEYBOARD_CLASS); clearTimeout(timer); } };
    const viewport = window.visualViewport;
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    viewport?.addEventListener("resize", schedule);
    return () => {
      clearTimeout(timer);
      root.classList.remove(KEYBOARD_CLASS);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      viewport?.removeEventListener("resize", schedule);
    };
  }, [ref]);
}

export function MemberCommunityPage({ token }) {
  const [state, setState] = React.useState(null);
  const [error, setError] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState({ profiles: [], more: false, offset: 0, status: "loading" });
  const [pending, setPending] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const searchRef = React.useRef(null);
  const moreControllerRef = React.useRef(null);
  const [version, reload] = React.useReducer((value) => value + 1, 0);
  const valid = () => token === readMemberToken();

  React.useEffect(() => () => moreControllerRef.current?.abort(), []);

  React.useEffect(() => {
    const controller = new AbortController();
    setState(null);
    communityRequest("/me/community", { token, signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted && valid()) setState(data); })
      .catch(() => { if (!controller.signal.aborted && valid()) setError("Community settings couldn’t load."); });
    return () => controller.abort();
  }, [token]);

  React.useEffect(() => {
    moreControllerRef.current?.abort();
    moreControllerRef.current = null;
    setLoadingMore(false);
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query, offset: "0" });
    setPage((current) => ({ ...current, status: "loading" }));
    communityRequest("/community/directory?" + params, { token, signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted && valid()) setPage({ ...data, offset: 0, status: "ready" }); })
      .catch(() => { if (!controller.signal.aborted && valid()) setPage({ profiles: [], more: false, offset: 0, status: "error" }); });
    return () => controller.abort();
  }, [token, query, version]);

  const trimmed = filter.trim();
  const wanted = trimmed.length >= 2 ? trimmed : "";
  React.useEffect(() => {
    if (wanted === query) return undefined;
    const timer = setTimeout(() => setQuery(wanted), 250);
    return () => clearTimeout(timer);
  }, [wanted, query]);
  useKeyboardSafeSearch(searchRef);

  async function save(data) {
    const result = await communityRequest("/me/community/profile", { token, method: "PUT", body: data });
    if (!valid()) return null;
    setState((current) => ({ ...current, profile: result.profile }));
    return result.profile;
  }

  async function older() {
    if (loadingMore || !valid()) return;
    moreControllerRef.current?.abort();
    const controller = new AbortController();
    moreControllerRef.current = controller;
    setLoadingMore(true);
    try {
      const nextOffset = page.offset + 25;
      const params = new URLSearchParams({ q: query, offset: String(nextOffset) });
      const result = await communityRequest("/community/directory?" + params, { token, signal: controller.signal });
      if (controller.signal.aborted || !valid()) return;
      setPage((current) => {
        const seen = new Set(current.profiles.map((p) => p.key));
        const extra = (result.profiles || []).filter((p) => !seen.has(p.key));
        return { ...current, profiles: current.profiles.concat(extra), more: result.more, offset: nextOffset, status: "ready" };
      });
    } catch (failure) {
      if (failure?.name !== "AbortError" && valid()) setError("More profiles couldn’t load.");
    } finally {
      if (moreControllerRef.current === controller) {
        moreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }

  async function update(contact, operation) {
    if (!valid() || pending) return;
    if (operation === "block") {
      const yes = await memberConfirm({
        title: "Block this member?",
        message: "This removes any connection and hides both profiles in signed-in community views. Public links can still be opened signed out.",
        confirmText: "Block member", tone: "danger",
      });
      if (!yes || !valid()) return;
    }
    setPending(true);
    setError("");
    try {
      const response = await communityRequest("/me/community/connections/" + contact, { token, method: "PUT", body: { action: operation } });
      if (!valid()) return;
      setState((current) => ({ ...current, ...response }));
      if (operation === "block" || operation === "unblock") reload();
    } catch (failure) {
      if (valid()) setError(failure.status === 409 ? "This connection is no longer available." : "Couldn’t update this connection.");
    } finally { setPending(false); }
  }

  if (!valid() || !state) return h("p", { className: "dash-note", role: "status" }, error || "Loading your community settings…");
  const relations = new Map(state.contacts.map((contact) => [contact.key, contact.relation]));
  return h("div", { className: "player-play member-community member-subpage member-community-hub", "data-member-community": "ready" }, [
    h(ProfileSettings, { key: "profile", initial: state.profile, save }),
    h(PrivateProgress, { key: "progress", progress: state.progress }),
    h("section", { className: "player-card member-community-friends", "aria-label": "Friends and requests", key: "friends" }, [
      h("h2", { key: "heading" }, "Friends and requests"),
      note(error),
      state.contacts.length ? h("ul", { className: "community-list", key: "items" }, state.contacts.map((contact) => h("li", { key: contact.key }, [
        contact.relation === "friend" && contact.displayName !== "Member"
          ? h("a", { className: "member-person", href: sharedProfileHref(contact.key), key: "name" }, contact.displayName)
          : h("strong", { className: "member-person", key: "name" }, contact.displayName),
        h(KarmaChip, { karmaKey: contact.karmaKey, key: "karma" }),
        h("p", { className: "player-card-meta", key: "status" }, contact.relation === "friend" ? "Friend" : contact.relation === "incoming" ? "Incoming request" : "Request sent"),
        h("div", { className: "dashboard-actions", key: "actions" }, [
          contact.relation === "incoming" ? connectionAction("Accept", "accept", pending, (operation) => update(contact.key, operation)) : null,
          connectionAction(contact.relation === "friend" ? "Remove friend" : contact.relation === "incoming" ? "Decline" : "Cancel request", "remove", pending, (operation) => update(contact.key, operation)),
          connectionAction("Block", "block", pending, (operation) => update(contact.key, operation)),
        ]),
      ]))) : note("No friends or requests yet.", "empty"),
      state.blocked.length ? h("details", { key: "blocks" }, [
        h("summary", { key: "label" }, "Blocked members"),
        h("ul", { className: "community-list", key: "list" }, state.blocked.map(({ key, displayName }) => h("li", { key }, [
          h("span", { className: "member-person", key: "name" }, displayName),
          h("div", { className: "member-action-grid", key: "unblock" }, [
            connectionAction("Unblock", "unblock", pending, (operation) => update(key, operation)),
          ]),
        ]))),
      ]) : null,
    ]),
    h("section", { className: "player-card member-community-directory", "aria-label": "Community directory", key: "directory" }, [
      h("h2", { key: "heading" }, "Community directory"),
      note("Find members who have shared a community profile."),
      h("form", { className: "community-form member-inline-search", role: "search", key: "filter", onSubmit: (event) => { event.preventDefault(); setQuery(wanted); } }, [
        field("Find a member", AutocompleteInput, { suggestions: page.profiles.map((item) => item.displayName).filter((name) => name && name !== "Member"),
          name: "memberSearch", type: "search", ref: searchRef, enterKeyHint: "search", autoComplete: "off", value: filter, maxLength: 60, onChange: (event) => setFilter(event.target.value) }),
        action("Search members", { type: "submit", key: "search" }),
      ]),
      page.status === "loading" || (wanted !== query && page.status !== "error") ? note("Searching the directory…", "loading") : page.status === "error" ? h("div", { className: "member-subactions", key: "directory-error" }, [
        h("p", { className: "dash-note", role: "alert", key: "error" }, "The directory couldn’t load."),
        action("Try again", { onClick: reload, key: "retry" }),
      ]) : page.profiles.length ? h("ul", { className: "community-list", key: "profiles" }, page.profiles.map((item) => h("li", { key: item.key }, [
        h("a", { className: "member-person", href: sharedProfileHref(item.key), key: "profile" }, item.displayName),
        h(KarmaChip, { karmaKey: item.karmaKey, key: "karma" }),
        h("div", { className: "dashboard-actions", key: "actions" }, [
          !relations.has(item.key) && state.profile.audience !== "private" ?
            connectionAction("Send friend request", "request", pending, (operation) => update(item.key, operation)) : null,
          connectionAction("Block", "block", pending, (operation) => update(item.key, operation)),
        ]),
      ]))) : note(query ? "No matching profiles." : "Type at least 2 letters to search.", "empty"),
      state.profile.audience === "private" ? note("Share a display name in your profile settings before sending requests.", "request-note") : null,
      page.status === "ready" && page.more ? action(loadingMore ? "Loading…" : "More members", { key: "more", disabled: pending || loadingMore, onClick: () => { void older(); } }) : null,
    ]),
  ]);
}
