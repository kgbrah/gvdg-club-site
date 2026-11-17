import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_BASE_YEAR,
  membershipStatus,
  registrationBlocked,
  renewalNoticeKey,
  renewalReminderYear,
  throughYearOf,
} from "../src/membership-year.js";

const dec1 = new Date("2026-12-01T15:00:00Z"); // 10:00 AM EST
const dec7 = new Date("2026-12-07T15:00:00Z");
const dec8 = new Date("2026-12-08T15:00:00Z");
const jan1 = new Date("2027-01-01T15:00:00Z");
const nov = new Date("2026-11-16T15:00:00Z");

describe("membership year", () => {
  it("treats a missing year as paid through the base year", () => {
    expect(throughYearOf({})).toBe(MEMBERSHIP_BASE_YEAR);
    expect(membershipStatus({}, nov)).toMatchObject({ throughYear: 2026, current: true, lapsed: false, renewalYear: 2027, remind: false });
  });

  it("lapses on January 1 until an admin marks the new year", () => {
    expect(membershipStatus({}, jan1)).toMatchObject({ currentYear: 2027, throughYear: 2026, current: false, lapsed: true, renewalYear: 2027 });
    expect(membershipStatus({ memberThroughYear: 2027 }, jan1).current).toBe(true);
    expect(membershipStatus({ memberThroughYear: 2027 }, jan1).renewalYear).toBe(2028);
  });

  it("opens only one year ahead", () => {
    expect(membershipStatus({ memberThroughYear: 2025 }, nov).renewalYear).toBe(2026);
    expect(membershipStatus({ memberThroughYear: 2027 }, nov).renewalYear).toBeNull();
  });

  it("reminds in December and sends that week only", () => {
    expect(membershipStatus({}, dec1).remind).toBe(true);
    expect(renewalReminderYear(dec1)).toBe(2026);
    expect(renewalReminderYear(dec7)).toBe(2026);
    expect(renewalReminderYear(dec8)).toBeNull();
    expect(renewalReminderYear(nov)).toBeNull();
    expect(renewalReminderYear(jan1)).toBeNull();
    expect(renewalNoticeKey(2026)).toBe("renewal-notice:2026");
  });

  it("blocks a new registration for a lapsed member, not an admin or a guest", () => {
    expect(registrationBlocked({ memberThroughYear: 2026 }, jan1)).toBe(true);
    expect(registrationBlocked({ memberThroughYear: 2026, isAdmin: true }, jan1)).toBe(false);
    expect(registrationBlocked(null, jan1)).toBe(false);
    expect(registrationBlocked({}, nov)).toBe(false);
  });
});
