import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { availableClubMembers } from '../src/admin-app/registration-member-picker.js';

test('availableClubMembers hides registered players and matches name, id, PDGA, or UDisc', () => {
  const members = [
    { memberId: 'm_jane', name: 'Jane Doe', pdgaNo: '111', udisc: 'janed' },
    { memberId: 'm_bob', name: 'Bob Smith', pdgaNo: '222', udisc: 'bsmith' },
    { memberId: 'm_ann', name: 'Ann Lee', pdgaNo: '333' },
  ];
  const registrations = [{ member_id: 'm_bob', name: 'Bob Smith' }];

  assert.deepEqual(availableClubMembers(members, registrations, '').map((m) => m.memberId), ['m_jane', 'm_ann']);
  assert.deepEqual(availableClubMembers(members, registrations, 'jane').map((m) => m.memberId), ['m_jane']);
  assert.deepEqual(availableClubMembers(members, registrations, '333').map((m) => m.memberId), ['m_ann']);
  assert.deepEqual(availableClubMembers(members, registrations, 'bsmith').map((m) => m.memberId), []);
  assert.deepEqual(availableClubMembers(members, registrations, 'm_ann').map((m) => m.memberId), ['m_ann']);
  assert.deepEqual(availableClubMembers(null, registrations, ''), []);
});

test('admin registration member picker adds club members as registrations from request events', () => {
  const html = `${readFileSync('admin.html', 'utf8')}\n${readFileSync('src/admin-app/admin-controller.js', 'utf8')}`;
  const panel = readFileSync('src/admin-app/registration-panel.js', 'utf8');
  const picker = readFileSync('src/admin-app/registration-member-picker.js', 'utf8');
  const rgSelectEvent = html.match(/async function rgSelectEventFromReact\(detail\) \{[\s\S]*?\n        \}/)?.[0];
  const rgLoadMembers = html.match(/async function rgLoadMembers\(\) \{[\s\S]*?\n        \}/)?.[0];
  const rgAddMembers = html.match(/async function rgAddMembersFromReact\(detail\) \{[\s\S]*?\n        \}/)?.[0];
  const initAdmin = html.match(/function initAdmin\(\) \{[\s\S]*?adminLoadEvents\(\);\n            adminLoadCourses\(\);\n            adminLoadLeagues\(\);\n        \}/)?.[0];

  assert.match(html, /function setAdminRegistrationClubMembersState\(state\) \{[\s\S]*new CustomEvent\('gvdg:admin-registration-members-list', \{ detail: state \}\)/);
  assert.match(html, /setAdminRegistrationClubMembersState\(\{ status: 'ready', members: \[\] \}\)/);
  assert.ok(rgSelectEvent);
  assert.match(rgSelectEvent, /rgLoadRoster\(\);[\s\S]*rgLoadMembers\(\);[\s\S]*rgLoadCtps\(\);/);
  assert.doesNotMatch(rgSelectEvent, /adminLoadMembers\(\)/);
  assert.ok(rgLoadMembers);
  assert.match(rgLoadMembers, /adminApi\('\/admin\/members'\)/);
  assert.match(rgLoadMembers, /setAdminRegistrationClubMembersState\(\{ status: 'loading', members: \[\] \}\)/);
  assert.match(rgLoadMembers, /setAdminRegistrationClubMembersState\(\{ status: ok \? 'ready' : 'error', members \}\)/);
  assert.doesNotMatch(rgLoadMembers, /adminLoadMembershipApplications/);
  assert.ok(rgAddMembers);
  assert.match(rgAddMembers, /if \(!rgEventId\) \{[\s\S]*?Select an event first[\s\S]*?gvdg:admin-registration-members-add-result[\s\S]*?ok: false, requestId[\s\S]*?return;/);
  assert.match(rgAddMembers, /adminApi\('\/admin\/events\/' \+ rgEventId \+ '\/registrations', \{ method: 'POST', body \}\)/);
  assert.match(rgAddMembers, /gvdg:admin-registration-members-add-result/);
  assert.match(rgAddMembers, /rgLoadRoster\(\)/);
  assert.doesNotMatch(rgAddMembers, /\/admin\/events\/' \+ rgEventId \+ '\/players'/);
  assert.ok(initAdmin);
  assert.match(initAdmin, /gvdg:admin-registration-members-add-request/);
  assert.match(initAdmin, /rgAddMembersFromReact\(event\.detail \|\| \{\}\)/);

  assert.match(panel, /import \{ AdminRegistrationMemberPicker \} from "\.\/registration-member-picker\.js"/);
  assert.match(panel, /h\(AdminRegistrationMemberPicker/);
  assert.match(panel, /key: "picker-" \+ eventId/);
  assert.match(panel, /eventStatus: selected \? selected.status : ""/);
  assert.match(panel, /h\(AdminRegistrationManualPlayerForm/);

  assert.match(picker, /export function availableClubMembers/);
  assert.match(picker, /export function AdminRegistrationMemberPicker/);
  assert.match(picker, /availableClubMembers\(membersState.members, registrations, ""\)/);
  assert.match(picker, /availableClubMembers\(membersState.members, registrations, query\)/);
  assert.match(picker, /unregisteredIds.has\(id\)/);
  assert.match(picker, /eventStatus === "live"/);
  assert.match(picker, /Once live scoring starts/);
  assert.match(picker, /data-react-admin-registration-member-picker/);
  assert.match(picker, /gvdg:admin-registration-members-list/);
  assert.match(picker, /gvdg:admin-registration-roster/);
  assert.match(picker, /gvdg:admin-registration-members-add-request/);
  assert.match(picker, /gvdg:admin-registration-members-add-result/);
  assert.match(picker, /id: "rgMemberSearch"/);
  assert.match(picker, /id: "rgMemberPaid"/);
  assert.match(picker, /Mark selected as paid \(cash collected\)/);
  assert.match(picker, /paid_entry: paidEntry/);
  assert.match(picker, /member_ids: selectedIds/);
  assert.doesNotMatch(picker, /availableIds.has\(id\)/);
  assert.match(html, /class: "rg-member-list"|rg-member-list \{/);
  assert.doesNotMatch(picker, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|🏆|⚠|⏱|—/);
});
