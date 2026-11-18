// Club membership is a calendar year in America/New_York: it covers January 1 through December 31
// and has to be renewed for the next year. Records written before this field existed are paid
// through MEMBERSHIP_BASE_YEAR only, so the 2026 roster does not all lapse the day this ships,
// and it does lapse on January 1, 2027 unless an admin marks them renewed.

export const CLUB_TIME_ZONE = "America/New_York";
export const MEMBERSHIP_BASE_YEAR = 2026;
/** December 1 is the reminder day. The next few mornings still send if that run was missed. */
export const RENEWAL_REMINDER_LAST_DAY = 7;

export interface MembershipView {
  throughYear: number;
  currentYear: number;
  current: boolean;
  lapsed: boolean;
  /** The one year an admin can mark next, or null when already renewed through next year. */
  renewalYear: number | null;
  /** December, and they are not yet renewed for the coming year. */
  remind: boolean;
  /** A guest account (tier set by an admin): not a dues-paying member, so never lapsed or reminded. */
  guest: boolean;
  /** Round history and stats: members, admins, and guests with a promo spot (the first 100 guest applications). */
  history: boolean;
}

type YearMember = { memberThroughYear?: number | null; isAdmin?: boolean; guest?: boolean; held?: boolean; guestPromo?: boolean };

function part(now: Date, type: Intl.DateTimeFormatPartTypes): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLUB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Number(parts.find((item) => item.type === type)?.value);
  return Number.isInteger(value) ? value : 0;
}

export function easternCalendarYear(now = new Date()): number {
  return part(now, "year") || now.getUTCFullYear();
}

export function easternMonthDay(now = new Date()): { year: number; month: number; day: number } {
  return { year: part(now, "year"), month: part(now, "month"), day: part(now, "day") };
}

export function throughYearOf(member: YearMember | null | undefined): number {
  const year = member?.memberThroughYear;
  if (typeof year === "number" && Number.isInteger(year) && year >= 2000 && year <= 2100) return year;
  return MEMBERSHIP_BASE_YEAR;
}

export function membershipStatus(member: YearMember | null | undefined, now = new Date()): MembershipView {
  const currentYear = easternCalendarYear(now);
  const throughYear = throughYearOf(member);
  const current = throughYear >= currentYear;
  const renewalYear = throughYear < currentYear ? currentYear : throughYear < currentYear + 1 ? currentYear + 1 : null;
  const month = easternMonthDay(now).month;
  if (member?.guest === true && member.isAdmin !== true) {
    return { throughYear, currentYear, current: false, lapsed: false, renewalYear: null, remind: false, guest: true, history: member.guestPromo === true };
  }
  return {
    throughYear,
    currentYear,
    current,
    lapsed: !current,
    renewalYear,
    remind: renewalYear != null && month === 12 && member?.held !== true,
    guest: false,
    history: true,
  };
}

export function publicMembership(member: YearMember | null | undefined, now = new Date()): MembershipView {
  return membershipStatus(member, now);
}

/** Lapsed members cannot open a new event registration. Admins and guests (walk-ups or guest accounts) are not blocked. */
export function registrationBlocked(member: YearMember | null | undefined, now = new Date()): boolean {
  if (!member || member.isAdmin === true) return false;
  return membershipStatus(member, now).lapsed;
}

/** Eastern year of a December 1–7 reminder window, or null the rest of the year. */
export function renewalReminderYear(now = new Date()): number | null {
  const { year, month, day } = easternMonthDay(now);
  if (month === 12 && day >= 1 && day <= RENEWAL_REMINDER_LAST_DAY) return year;
  return null;
}

export function renewalNoticeKey(year: number): string {
  return `renewal-notice:${year}`;
}
