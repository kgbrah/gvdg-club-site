import assert from 'node:assert/strict';
import test from 'node:test';
import { safeExternalUrl } from '../safe-url.js';

test('safeExternalUrl allows http and https URLs', () => {
  assert.equal(safeExternalUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(safeExternalUrl('http://example.com/path'), 'http://example.com/path');
});

test('safeExternalUrl rejects script, data, relative, and malformed URLs', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(safeExternalUrl('data:text/html,<script></script>'), '');
  assert.equal(safeExternalUrl('/local/path'), '');
  assert.equal(safeExternalUrl('not a url'), '');
});
