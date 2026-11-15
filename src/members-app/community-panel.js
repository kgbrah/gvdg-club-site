import React from "react";
import { request } from "./api.js";
import { readMemberToken, TOKEN_KEY } from "../shared/member-session.js";
import { memberConfirm } from "./member-dialogs.js";

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

function profilePreview(profile) {
  return [
    h("h1", { className: "section-title", key: "name" }, profile.displayName || "Club member"),
    profile.bio ? h("p", { className: "community-body", key: "bio" }, profile.bio) : null,
    profile.progress ? h("p", { className: "dash-note", key: "progress" },
      profile.progress.total + " completed GVDG rounds") : null,
  ];
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
      state.profile ? profilePreview(state.profile) : h("h1", { className: "login-title", key: "title" }, state.pending ? "Loading profile…" : "Profile unavailable"),
      h("a", { className: "dashboard-action", href: "gvdg-members.html#community", key: "members" }, "Open the member app"),
    ]));
}

function ProfileSettings({ initial, save }) {
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
        audience: form.audience, displayName: form.displayName, bio: form.bio,
        shareProgress: form.audience !== "private" && form.shareProgress, revision: initial.revision,
      });
      if (updated) setForm(updated);
      setMessage("Profile settings saved.");
    } catch (error) {
      setMessage(error.status === 409 ? "This profile changed in another tab. Reload before saving." : "Profile settings couldn’t be saved.");
    } finally { setBusy(false); }
  }

  return h("form", { className: "player-card community-form", onSubmit: submit }, [
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
  return h("section", { className: "player-card", "aria-label": "Your progress", key: "progress" }, [
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

export function MemberCommunityPage({ token }) {
  const [state, setState] = React.useState(null);
  const [error, setError] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState({ profiles: [], more: false, offset: 0 });
  const [pending, setPending] = React.useState(false);
  const [version, reload] = React.useReducer((value) => value + 1, 0);
  const valid = () => token === readMemberToken();

  React.useEffect(() => {
    const controller = new AbortController();
    setState(null);
    communityRequest("/me/community", { token, signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted && valid()) setState(data); })
      .catch(() => { if (!controller.signal.aborted && valid()) setError("Community settings couldn’t load."); });
    return () => controller.abort();
  }, [token]);

  React.useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query, offset: "0" });
    communityRequest("/community/directory?" + params, { token, signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted && valid()) setPage({ ...data, offset: 0 }); })
      .catch(() => { if (!controller.signal.aborted && valid()) setPage({ profiles: [], more: false, offset: 0 }); });
    return () => controller.abort();
  }, [token, query, version]);

  async function save(data) {
    const result = await communityRequest("/me/community/profile", { token, method: "PUT", body: data });
    if (!valid()) return null;
    setState((current) => ({ ...current, profile: result.profile }));
    return result.profile;
  }

  async function older() {
    setPending(true);
    try {
      const params = new URLSearchParams({ q: query, offset: String(page.offset + 25) });
      const result = await communityRequest("/community/directory?" + params, { token });
      if (valid()) setPage({ profiles: page.profiles.concat(result.profiles), more: result.more, offset: page.offset + 25 });
    } catch { setError("More profiles couldn’t load."); }
    finally { setPending(false); }
  }

  async function update(contact, operation) {
    if (!valid() || pending) return;
    if (operation === "block") {
      const yes = await memberConfirm({
        title: "Block this member?",
        message: "This removes any connection and hides both profiles in signed-in community views. Public links can still be opened signed out.",
        confirmText: "Block member", danger: true,
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
  return h("div", { className: "player-play member-community", "data-member-community": "ready" }, [
    h(ProfileSettings, { key: "profile", initial: state.profile, save }),
    h(PrivateProgress, { key: "progress", progress: state.progress }),
    h("section", { className: "player-card", "aria-label": "Friends and requests", key: "friends" }, [
      h("h2", { key: "heading" }, "Friends and requests"),
      note(error),
      state.contacts.length ? h("ul", { className: "community-list", key: "items" }, state.contacts.map((contact) => h("li", { key: contact.key }, [
        contact.relation === "friend" && contact.displayName !== "Member"
          ? h("a", { href: sharedProfileHref(contact.key), key: "name" }, contact.displayName)
          : h("strong", { key: "name" }, contact.displayName),
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
          h("span", { key: "name" }, displayName),
          connectionAction("Unblock", "unblock", pending, (operation) => update(key, operation)),
        ]))),
      ]) : null,
    ]),
    h("section", { className: "player-card", "aria-label": "Community directory", key: "directory" }, [
      h("h2", { key: "heading" }, "Community directory"),
      note("Find members who have shared a community profile."),
      h("form", { className: "community-form", role: "search", key: "filter", onSubmit: (event) => { event.preventDefault(); setQuery(filter.trim()); } }, [
        field("Find a member", "input", { name: "memberSearch", type: "search", value: filter, maxLength: 60, onChange: (event) => setFilter(event.target.value) }),
        action("Search members", { type: "submit", key: "search" }),
      ]),
      page.profiles.length ? h("ul", { className: "community-list", key: "profiles" }, page.profiles.map((item) => h("li", { key: item.key }, [
        h("a", { href: sharedProfileHref(item.key), key: "profile" }, item.displayName),
        h("div", { className: "dashboard-actions", key: "actions" }, [
          !relations.has(item.key) && state.profile.audience !== "private" ?
            connectionAction("Send friend request", "request", pending, (operation) => update(item.key, operation)) : null,
          connectionAction("Block", "block", pending, (operation) => update(item.key, operation)),
        ]),
      ]))) : note("No matching profiles.", "empty"),
      state.profile.audience === "private" ? note("Share a display name in your profile settings before sending requests.", "request-note") : null,
      page.more ? action("More members", { key: "more", disabled: pending, onClick: () => { void older(); } }) : null,
    ]),
  ]);
}
