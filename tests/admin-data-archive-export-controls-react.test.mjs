import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('admin data archive export controls are rendered by React from request events', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const controls = readFileSync('src/admin-app/data-archive-export-controls.js', 'utf8');
  const loadDestinations = html.match(/async function adminLoadDataArchiveDestinations\(\) \{[\s\S]*?\n        \}/)?.[0];
  const runExport = html.match(/async function adminRunArchiveExportFromReact\(detail\) \{[\s\S]*?function adminSwitch/)?.[0];
  const initAdmin = html.match(/function initAdmin\(\) \{[\s\S]*?\$\('adminCreateForm'\)\.addEventListener/)?.[0];

  assert.match(html, /id="adminDataArchiveExportControlsReactApp"/);
  assert.doesNotMatch(html, /id="dxExportFrom"|id="dxExportTo"|id="dxExportDestination"|id="dxIncludeEventPlayers"|id="dxIncludeResults"|id="dxIncludeCasualRounds"|id="dxIncludeEventConfig"|id="dxDryRun"|id="dxTest"|id="dxRunExport"/);
  assert.ok(loadDestinations);
  assert.match(loadDestinations, /setAdminDataArchiveDestinationsState\(\{ status: 'ready', destinations \}\)/);
  assert.doesNotMatch(loadDestinations, /dxExportDestination|replaceChildren|document\.createElement|appendChild|selected/);
  assert.ok(runExport);
  assert.match(runExport, /adminApi\('\/admin\/export', \{ method: 'POST', body \}\)/);
  assert.match(runExport, /gvdg:admin-data-archive-export-run-result/);
  assert.doesNotMatch(runExport, /dxExportFrom|dxExportTo|dxExportDestination|dxIncludeEventPlayers|dxIncludeResults|dxIncludeCasualRounds|dxIncludeEventConfig|dxDryRun|dxTest|dxRunExport/);
  assert.ok(initAdmin);
  assert.match(initAdmin, /gvdg:admin-data-archive-export-run-request/);
  assert.match(initAdmin, /adminRunArchiveExportFromReact\(event\.detail \|\| \{\}\)/);
  assert.doesNotMatch(initAdmin, /\$\('dxRunExport'\)\.addEventListener/);
  assert.match(main, /import \{ AdminDataArchiveExportControls \} from "\.\/data-archive-export-controls\.js"/);
  assert.match(main, /const dataArchiveExportControlsMount = document\.getElementById\("adminDataArchiveExportControlsReactApp"\)/);
  assert.match(main, /createRoot\(dataArchiveExportControlsMount\)\.render\(h\(AdminDataArchiveExportControls\)\)/);
  assert.match(controls, /export function AdminDataArchiveExportControls/);
  assert.match(controls, /data-react-admin-data-archive-export-controls/);
  assert.match(controls, /gvdg:admin-data-archive-destinations-list/);
  assert.match(controls, /gvdg:admin-data-archive-export-run-request/);
  assert.match(controls, /gvdg:admin-data-archive-export-run-result/);
  assert.match(controls, /id: "dxExportFrom"/);
  assert.match(controls, /id: "dxExportTo"/);
  assert.match(controls, /id: "dxExportDestination"/);
  assert.match(controls, /id: "dxRunExport"/);
  assert.doesNotMatch(controls, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️|🏆|⚠|⏱|—/);
});
