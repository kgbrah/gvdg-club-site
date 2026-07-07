import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('admin data archive export result is rendered by React from legacy export state', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const dataArchive = readFileSync('src/admin-app/data-archive-destinations-list.js', 'utf8');
  const setExportResult = html.match(/function setDataArchiveExportResult\(message, ok\) \{[\s\S]*?\n        \}/)?.[0];

  assert.match(html, /id="adminDataArchiveExportResultReactApp"/);
  assert.doesNotMatch(html, /id="dxExportResult"/);
  assert.ok(setExportResult);
  assert.match(setExportResult, /window\.__gvdgAdminDataArchiveExportResultState = state/);
  assert.match(setExportResult, /gvdg:admin-data-archive-export-result/);
  assert.doesNotMatch(setExportResult, /dxExportResult|textContent|className|querySelector|classList/);
  assert.match(main, /import \{ AdminDataArchiveDestinationsList, AdminDataArchiveExportResult \} from "\.\/data-archive-destinations-list\.js"/);
  assert.match(main, /const dataArchiveExportResultMount = document\.getElementById\("adminDataArchiveExportResultReactApp"\)/);
  assert.match(main, /createRoot\(dataArchiveExportResultMount\)\.render\(h\(AdminDataArchiveExportResult\)\)/);
  assert.match(dataArchive, /export function AdminDataArchiveExportResult/);
  assert.match(dataArchive, /window\.__gvdgAdminDataArchiveExportResultState/);
  assert.match(dataArchive, /gvdg:admin-data-archive-export-result/);
  assert.match(dataArchive, /data-react-admin-data-archive-export-result/);
  assert.match(dataArchive, /role: state\.ok === false \? "alert" : "status"/);
  assert.doesNotMatch(dataArchive, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️|🏆|⚠|⏱|—/);
});
