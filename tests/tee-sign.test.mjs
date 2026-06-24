// node --test tests/tee-sign.test.mjs   (from repo root)
// Pure unit tests for the tee-sign SVG renderer — no DOM, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeXml, sanitizeColor } from '../tee-sign.js';

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
