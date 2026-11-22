import { NAME_KEY, PDGA_KEY, TOKEN_KEY, storageGet } from "./api.js";
import { setMemberContext } from "./member-context.js";
import { memberTokenSubject, writeMemberSessionValue } from "../shared/member-session.js";

let memberProfile = {
  isAdmin: false,
  membership: null,
  name: null,
  pdgaNo: null,
  photo: null,
  sub: null,
  udisc: null,
  welcome: false,
  email: null,
  needsEmail: false,
  emailRequired: false,
};

export function memberDashboardContext() {
  return {
    isAdmin: memberProfile.isAdmin === true,
    membership: memberProfile.membership,
    name: memberProfile.name || storageGet(NAME_KEY) || null,
    pdgaNo: memberProfile.pdgaNo || storageGet(PDGA_KEY) || null,
    photo: memberProfile.photo || null,
    sub: memberProfile.sub || memberTokenSubject(storageGet(TOKEN_KEY)) || null,
    welcome: memberProfile.welcome === true,
    email: memberProfile.email || null,
    needsEmail: memberProfile.needsEmail === true,
    emailRequired: memberProfile.emailRequired === true,
  };
}

export function memberAuthProfile() {
  return { ...memberProfile };
}

export function publishMemberProfile(detail = memberDashboardContext()) {
  const context = setMemberContext(detail);
  window.dispatchEvent(new CustomEvent("gvdg:member-profile-updated", { detail: context }));
}

export function applyProfile(data = {}) {
  memberProfile = {
    isAdmin: data.isAdmin === undefined ? memberProfile.isAdmin === true : data.isAdmin === true,
    membership: data.membership ? data.membership : memberProfile.membership,
    name: data.name || memberProfile.name || null,
    pdgaNo: data.pdgaNo === undefined ? memberProfile.pdgaNo || null : data.pdgaNo || null,
    photo: data.photo === undefined ? memberProfile.photo || null : data.photo || null,
    sub: data.sub || memberProfile.sub || memberTokenSubject(storageGet(TOKEN_KEY)) || null,
    udisc: data.udisc === undefined ? memberProfile.udisc || null : data.udisc || null,
    welcome: data.welcome === undefined ? memberProfile.welcome === true : data.welcome === true,
    // Older payloads have no email fields: keep what we knew.
    email: data.email === undefined ? memberProfile.email || null : data.email || null,
    needsEmail: data.needsEmail === undefined ? memberProfile.needsEmail === true : data.needsEmail === true,
    emailRequired: data.emailRequired === undefined ? memberProfile.emailRequired === true : data.emailRequired === true,
  };

  if (data.name) writeMemberSessionValue(NAME_KEY, data.name);
  if (data.pdgaNo !== undefined) {
    if (data.pdgaNo) writeMemberSessionValue(PDGA_KEY, data.pdgaNo);
    else writeMemberSessionValue(PDGA_KEY, "");
  }

  publishMemberProfile();
}

export function resetMemberProfile() {
  memberProfile = {
    isAdmin: false,
    membership: null,
    name: null,
    pdgaNo: null,
    photo: null,
    sub: null,
    udisc: null,
    welcome: false,
    email: null,
    needsEmail: false,
    emailRequired: false,
  };
  publishMemberProfile(memberDashboardContext());
}

/** The member just confirmed an email (POST /me/email/verify). */
export function markEmailSaved(email) {
  memberProfile = { ...memberProfile, email: email || memberProfile.email || null, needsEmail: false, emailRequired: false };
  publishMemberProfile(memberDashboardContext());
}
