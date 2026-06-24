// node --test tests/tee-sign.test.mjs   (from repo root)
// Pure unit tests for the tee-sign SVG renderer — no DOM, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeXml, sanitizeColor, teeSignModel } from '../tee-sign.js';

test('escapeXml escapes the five XML metacharacters', () => {
  assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(42), '42');
});

test('sanitizeColor accepts known names and #hex, rejects everything else', () => {
  assert.equal(sanitizeColor('Blue'), 'blue');   // case-insensitive
  assert.equal(sanitizeColor('  red '), 'red');  // trimmed
  assert.equal(sanitizeColor('#0a0'), '#0a0');
  assert.equal(sanitizeColor('#00AAFF'), '#00aaff');
  assert.equal(sanitizeColor('red; fill:url(#x)'), null);   // CSS injection
  assert.equal(sanitizeColor('expression(alert(1))'), null);
  assert.equal(sanitizeColor('#1234'), null);    // 4-digit hex not allowed
  assert.equal(sanitizeColor(null), null);
});

test('teeSignModel clamps par/distance, sanitizes color, coerces strings', () => {
  const m = teeSignModel({
    hole: '7',
    courseName: 'Battle Park',
    layouts: [
      { label: 'Long', color: 'Blue', par: '4', distance_ft: '420', distance_source: 'geo' },
      { label: 'Short', color: 'bogus', par: 99, distance_ft: 5 },
    ],
  });
  assert.equal(m.hole, 7);
  assert.equal(m.courseName, 'Battle Park');
  assert.deepEqual(m.layouts[0], {
    label: 'Long', color: 'blue', par: 4, distance_ft: 420, distance_source: 'geo',
  });
  assert.equal(m.layouts[1].color, null);        // bogus name dropped
  assert.equal(m.layouts[1].par, null);          // 99 out of [1,10]
  assert.equal(m.layouts[1].distance_ft, null);  // 5 below [20,2000]
});

test('teeSignModel is null-safe and defaults empty', () => {
  const m = teeSignModel(null);
  assert.equal(m.hole, null);
  assert.equal(m.courseName, '');
  assert.deepEqual(m.layouts, []);
});
