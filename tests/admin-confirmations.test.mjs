import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('admin live scoring layout selector uses themed picker styles', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /<select id="scLayout"/);
  assert.match(html, /#alCourse,\s*#scEvent,\s*#scLayout,\s*#rgEvent\s*\{/);
});

test('admin registration bulk assignment controls confirm destructive changes', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /id="rgAssignCards"/);
  assert.match(html, /id="rgAssignTeams"/);
  assert.match(html, /id="rgTeamSize"/);
  assert.match(html, /confirm\([^)]*Existing/s);
  assert.match(html, /confirm_assignment_overwrite: true/);
  assert.match(html, /btn\.disabled = true; btn\.textContent = 'Assigning\.\.\.'/);
});

test('admin registration settings require confirmation payload', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /Save registration settings for this event\?/);
  assert.match(html, /confirm_event_config_update: true/);
  assert.match(html, /event_config_confirmation_required/);
});

test('admin wallet adjustments confirm and carry retry keys', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /id="waSubmit"/);
  assert.match(html, /wallet-adjustment:/);
  assert.match(html, /idempotency_key: key/);
  assert.match(html, /confirm_wallet_adjustment: true/);
  assert.match(html, /confirm\('Post ' \+ dollarsFromCents\(amount\)/);
  assert.match(html, /btn\.disabled = true; btn\.textContent = 'Posting\.\.\.'/);
});

test('admin event store credit awards require confirmation payloads', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Award ' \+ dollarsFromCents\(amount\) \+ ' store credit to '/);
  assert.match(html, /confirm_event_store_credit_award: true/);
  assert.match(html, /confirm\('Award ' \+ dollarsFromCents\(amount\) \+ ' CTP store credit to '/);
  assert.match(html, /confirm_ctp_store_credit_award: true/);
});

test('admin member creation confirms admin grants before submitting', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /id="amSubmit"/);
  assert.match(html, /confirm\('Create ' \+ body\.name \+ ' as a club admin/);
  assert.match(html, /body\.confirm_admin_grant = true/);
  assert.match(html, /btn\.disabled = true; btn\.textContent = 'Creating\.\.\.'/);
});

test('admin PIN resets require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Issue a new temporary PIN for ' \+ m\.name/);
  assert.match(html, /confirm_member_pin_reset: true/);
});

test('admin ace pot resolution confirms payout and carry actions', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /id="rgAcePayout"/);
  assert.match(html, /id="rgAceCarryNext"/);
  assert.match(html, /confirm\('Mark ace pot paid out to ' \+ winner/);
  assert.match(html, /confirm\('Carry this ace pot to the next event/);
  assert.match(html, /confirm_ace_pot_resolution: true/);
  assert.match(html, /btn\.disabled = true; btn\.textContent = busyText/);
});

test('admin paid registration changes require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /Paid\?/);
  assert.match(html, /confirm\('Mark ' \+ name \+ ' as paid for this event\?'\)/);
  assert.match(html, /confirm\('Mark ' \+ name \+ ' as unpaid for this event\?'\)/);
  assert.match(html, /confirm_paid_entry_change: true/);
});

test('admin order status changes require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /ORDER_STATUS_LABELS/);
  assert.match(html, /confirm\('Change order #' \+ order\.id/);
  assert.match(html, /confirm_order_status_change = true/);
  assert.match(html, /Save fulfillment details for order #/);
  assert.match(html, /confirm_order_fulfillment_update: true/);
  assert.match(html, /order_fulfillment_confirmation_required/);
});

test('admin product archive changes require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Archive “' \+ p\.name/);
  assert.match(html, /confirm_product_archive: true/);
});

test('admin product updates require confirmation payload', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Save product changes for “' \+ \(p\.name \|\| 'Product'\)/);
  assert.match(html, /confirm_product_update: true/);
  assert.match(html, /product_update_confirmation_required/);
});

test('admin event status changes require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /function confirmEventStatusChange/);
  assert.match(html, /confirm\('Change “' \+ ev\.name \+ '” from '/);
  assert.match(html, /body\.confirm_event_status_change = true/);
});

test('admin event detail updates require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /Update event details for/);
  assert.match(html, /body\.confirm_event_details_update = true/);
  assert.match(html, /event_details_confirmation_required/);
});

test('admin fundraiser status changes require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Close fundraiser “' \+ f\.title/);
  assert.match(html, /confirm\('Reopen fundraiser “' \+ f\.title/);
  assert.match(html, /confirm_fundraiser_status_change: true/);
});

test('admin delete blockers surface dependent records', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /DELETE_BLOCKER_LABELS/);
  assert.match(html, /course_layouts: 'layouts'/);
  assert.match(html, /round_ratings: 'round ratings'/);
  assert.match(html, /winner: 'a recorded winner'/);
  assert.match(html, /confirm_event_delete: true/);
  assert.match(html, /confirm_layout_delete: true/);
  assert.match(html, /deleteBlockedMessage\('event', r\.status, d\)/);
  assert.match(html, /deleteBlockedMessage\('layout', r\.status, d\)/);
  assert.match(html, /confirm\('Delete CTP for hole ' \+ c\.hole \+ '\?'\)/);
  assert.match(html, /confirm_ctp_delete: true/);
  assert.match(html, /deleteBlockedMessage\('CTP', r\.status, d\)/);
  assert.match(html, /del\.disabled = true; del\.textContent = 'Deleting\.\.\.'/);
});

test('admin content deletes require confirmation payloads', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Delete league “' \+ l\.name/);
  assert.match(html, /confirm_league_delete: true/);
  assert.match(html, /confirm\('Delete fundraiser “' \+ f\.title/);
  assert.match(html, /confirm_fundraiser_delete: true/);
  assert.match(html, /confirm\('Delete meeting “' \+ m\.title/);
  assert.match(html, /confirm_meeting_delete: true/);
});

test('admin manual player removal requires confirmation payload', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Remove ' \+ \(player\.name \|\| 'this player'\)/);
  assert.match(html, /confirm_event_player_delete: true/);
});

test('admin CTP winner changes require confirmation payload', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /Set CTP winner for hole ' \+ c\.hole \+ ' to '/);
  assert.match(html, /confirm\(ask\)/);
  assert.match(html, /confirm_ctp_winner_change: true/);
});

test('admin CTP creation requires confirmation payload', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm\('Add CTP for hole ' \+ hole \+ '\? This changes public CTP options/);
  assert.match(html, /confirm_ctp_create: true/);
  assert.match(html, /ctp_create_confirmation_required/);
});

test('admin course position deletes require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /alDeletePosition\(p\)/);
  assert.match(html, /confirm\('Delete ' \+ p\.kind \+ ' position “' \+ p\.label/);
  assert.match(html, /confirm_course_position_delete: true/);
});

test('admin live scorecard cancellation requires confirmation payload', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /id="scCancelBtn"/);
  assert.match(html, /Cancel live scoring for this event\?/);
  assert.match(html, /confirm_live_scorecard_cancel: true/);
  assert.match(html, /live_scorecard_cancel_confirmation_required/);
});

test('admin UDisc position imports require replacement confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /Replace tee\/target positions for this course with imported UDisc layout/);
  assert.match(html, /confirm_course_positions_replace: true/);
  assert.match(html, /course_positions_replace_confirmation_required/);
});

test('admin layout updates require confirmation payload', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /Update layout “' \+ name \+ '”/);
  assert.match(html, /confirm_layout_update: true/);
  assert.match(html, /layout_update_confirmation_required/);
});

test('admin tee sign review actions require confirmation', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /confirm_tee_sign_approval: true/);
  assert.match(html, /confirm_tee_sign_reject: true/);
  assert.match(html, /confirm_tee_sign_delete: true/);
});
