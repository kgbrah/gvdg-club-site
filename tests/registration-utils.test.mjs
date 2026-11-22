import assert from "node:assert/strict";
import test from "node:test";

import { clientOwed, eventFromRegistration, pickUnpaidJobs } from "../src/members-app/registration-utils.js";

test("clientOwed adds optional pots to entry", () => {
  const event = { entry_fee_cents: 2000, ctp_fee_cents: 200, ace_fee_cents: 300 };
  assert.equal(clientOwed(event, {}), 2000);
  assert.equal(clientOwed(event, { ctp: true, ace: true }), 2500);
});

test("pickUnpaidJobs keeps live/scheduled unpaid rows with a known fee", () => {
  const events = [
    { id: 11, name: "League Night", entry_fee_cents: 500, ctp_fee_cents: 200 },
    { id: 12, name: "C-Tier", entry_fee_cents: 2000 },
  ];
  const jobs = pickUnpaidJobs(events, [
    { event_id: 12, event_name: "C-Tier", event_status: "scheduled", event_date: "2026-07-09", paid_entry: 0 },
    { event_id: 11, event_name: "League Night", event_status: "live", event_date: "2026-07-08", paid_entry: 0, addons: { ctp: true } },
    { event_id: 11, event_name: "League Night", event_status: "live", paid_entry: 1 },
    { event_id: 13, event_name: "Old Weekly", event_status: "final", paid_entry: 0 },
    { event_id: 14, event_name: "Mystery", event_status: "scheduled", paid_entry: 0 },
  ]);
  assert.deepEqual(jobs.map((job) => [job.event.name, job.owed]), [
    ["League Night", 700],
    ["C-Tier", 2000],
  ]);
});

test("eventFromRegistration preserves pdga_event_id for member cards", () => {
  assert.equal(eventFromRegistration({ event_id: 7, pdga_event_id: 104547 }).pdga_event_id, 104547);
  assert.equal(eventFromRegistration({ event_id: 8 }).pdga_event_id, null);
});
