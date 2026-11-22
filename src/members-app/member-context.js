import React from "react";

import { NAME_KEY, PDGA_KEY, TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { memberTokenSubject } from "../shared/member-session.js";
import { shownProfilePhoto } from "../shared/profile-photo.js";

let memberContext = {};
let meTokenLoaded = "";
let meInFlight = null;

function membershipFrom(value) {
  if (!value || typeof value !== "object" || !Number.isInteger(value.throughYear)) return null;
  return {
    current: value.current !== false,
    currentYear: Number.isInteger(value.currentYear) ? value.currentYear : null,
    // A guest account (tier set by an admin): not a dues-paying member, so never lapsed.
    guest: value.guest === true,
    // Round history and stats (members, admins, promo guests). Absent from older payloads = allowed.
    history: value.history !== false,
    lapsed: value.guest !== true && (value.lapsed === true || value.current === false),
    remind: value.remind === true,
    renewalYear: Number.isInteger(value.renewalYear) ? value.renewalYear : null,
    throughYear: value.throughYear,
  };
}

export function setMemberContext(detail = {}) {
  memberContext = {
    isAdmin: detail.isAdmin === true,
    membership: membershipFrom(detail.membership),
    name: detail.name || null,
    pdgaNo: detail.pdgaNo || null,
    photo: shownProfilePhoto(detail.photo) || null,
    sub: detail.sub || null,
    welcome: detail.welcome === true,
    email: typeof detail.email === "string" && detail.email ? detail.email : null,
    needsEmail: detail.needsEmail === true,
    emailRequired: detail.emailRequired === true,
  };
  return readMemberContext(memberContext);
}

export function readMemberContext(detail = null) {
  const stored = memberContext;
  const source = detail || stored;
  return {
    name: source.name || stored.name || storageGet(NAME_KEY) || null,
    pdgaNo: source.pdgaNo || stored.pdgaNo || storageGet(PDGA_KEY) || null,
    photo: shownProfilePhoto(source.photo) || shownProfilePhoto(stored.photo) || null,
    isAdmin: source.isAdmin === true || stored.isAdmin === true,
    membership: membershipFrom(source.membership) || membershipFrom(stored.membership),
    sub: source.sub || stored.sub || memberTokenSubject(storageGet(TOKEN_KEY)) || null,
    // Routing events (e.g. gvdg:member-dashboard-ready) carry no `welcome`; only an explicit value may change
    // it, otherwise a just-approved member's welcome card vanished whenever that event landed after /me.
    welcome: source.welcome === undefined ? stored.welcome === true : source.welcome === true,
    // Same rule: only a payload that says so changes the email (routing events don't carry it).
    email: source.email === undefined ? stored.email || null : source.email || null,
    needsEmail: source.needsEmail === undefined ? stored.needsEmail === true : source.needsEmail === true,
    emailRequired: source.emailRequired === undefined ? stored.emailRequired === true : source.emailRequired === true,
  };
}

export function useMemberContext() {
  const [context, setContext] = React.useState(() => readMemberContext());

  React.useEffect(() => {
    function update(event) {
      setContext(readMemberContext(event.detail || null));
    }

    window.addEventListener("gvdg:member-profile-updated", update);
    window.addEventListener("gvdg:member-dashboard-ready", update);
    return () => {
      window.removeEventListener("gvdg:member-profile-updated", update);
      window.removeEventListener("gvdg:member-dashboard-ready", update);
    };
  }, []);

  const token = storageGet(TOKEN_KEY);
  React.useEffect(() => {
    if (!token) {
      meTokenLoaded = "";
      meInFlight = null;
      return undefined;
    }
    if (memberContext.sub && memberContext.name && meTokenLoaded === token) return undefined;

    let active = true;
    const loadMe = () => {
      if (meInFlight && meInFlight.token === token) return meInFlight.promise;
      const promise = requestJson("/me", { token })
        .then((profile) => {
          if (storageGet(TOKEN_KEY) !== token) return readMemberContext();
          meTokenLoaded = token;
          if (!profile || typeof profile !== "object") return readMemberContext();
          return setMemberContext({
            name: profile.name || storageGet(NAME_KEY) || null,
            pdgaNo: profile.pdgaNo || storageGet(PDGA_KEY) || null,
            photo: profile.photo || null,
            isAdmin: profile.isAdmin === true,
            membership: profile.membership || null,
            sub: profile.sub || null,
            welcome: profile.welcome === true,
            // Keep the email fields too: without them this refresh wiped the email for every screen.
            email: profile.email || null,
            needsEmail: profile.needsEmail === true,
            emailRequired: profile.emailRequired === true,
          });
        })
        .finally(() => {
          if (meInFlight && meInFlight.token === token && meInFlight.promise === promise) meInFlight = null;
        });
      meInFlight = { token, promise };
      return promise;
    };

    loadMe()
      .then((next) => {
        if (active && next) setContext(next);
      })
      .catch(() => {
        if (active) setContext(readMemberContext());
      });

    return () => { active = false; };
  }, [token]);

  return context;
}
