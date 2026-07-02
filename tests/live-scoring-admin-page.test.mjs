import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('admin live start area sends normalized scoring config', () => {
  const source = readFileSync('admin.html', 'utf8');
  assert.match(source, /id="scGroupFormat"/);
  assert.match(source, /id="scScoringStyle"/);
  assert.match(source, /function scCurrentConfig\(\)/);
  assert.match(source, /const body = \$\('scUseManualPlayers'\)\.checked \? \{ from: 'players', liveScoringConfig \} : \{ liveScoringConfig \}/);
});

test('admin start defaults preserve saved and legacy format fields separately', () => {
  const source = readFileSync('admin.html', 'utf8');
  assert.match(source, /function scNormalizeConfig\(raw, fallbackPlayFormat, fallbackEventFormat\)/);
  assert.match(source, /groupFormat: fallbackPlayFormat === 'doubles' \? 'doubles' : 'singles'/);
  assert.match(source, /scoringStyle: fallbackEventFormat === 'matchplay' \? 'matchplay' : 'stroke'/);
  assert.match(source, /o\.dataset\.playFormat = e\.play_format \|\| ''/);
  assert.match(source, /o\.dataset\.eventFormat = e\.format \|\| ''/);
  assert.match(source, /play_format: opt\.dataset\.playFormat \|\| null, format: opt\.dataset\.eventFormat \|\| null/);
  assert.doesNotMatch(source, /o\.dataset\.format = e\.play_format \|\| e\.format/);
});

test('admin live grid uses pair target rows and target-id score posts', () => {
  const source = readFileSync('admin.html', 'utf8');
  assert.match(source, /function scScoreRows\(\)/);
  assert.match(source, /target\.type === 'pair'/);
  assert.match(source, /body\.targetId = row\.targetId/);
  assert.match(source, /scIsMatchplay\(\) \? 'Match' : 'To Par'/);
  assert.ok(source.includes("s.members.join(' / ')"));
});
