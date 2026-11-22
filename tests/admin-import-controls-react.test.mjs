import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('admin import controls are rendered by React from request events', () => {
  const html = `${readFileSync('admin.html', 'utf8')}\n${readFileSync('src/admin-app/admin-controller.js', 'utf8')}`;
  const importController = readFileSync('src/admin-app/import-controller.js', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const controls = readFileSync('src/admin-app/import-controls.js', 'utf8');
  const adminCsvImport = importController.match(/export async function adminCsvImportFromReact\(detail, \{ adminApi, adminMsg \}\) \{[\s\S]*?export async function adminUdiscEventsImportFromReact/)?.[0];

  assert.match(html, /id="adminImportControlsReactApp"/);
  assert.doesNotMatch(html, /id="dgsImportBtn"|id="csvImportBtn"|id="csvImportText"/);
  assert.doesNotMatch(importController, /adminDgsImportFromReact|\/admin\/import\/dgs|gvdg:admin-dgs-import-request/);
  assert.doesNotMatch(controls, /id:\s*"dgsImportBtn"|gvdg:admin-dgs-import-request|Import from DiscGolfScene feed/);
  assert.ok(adminCsvImport);
  assert.match(adminCsvImport, /adminApi\('\/admin\/import\/csv', \{ method: 'POST', body: \{ csv \} \}\)/);
  assert.match(adminCsvImport, /gvdg:admin-csv-import-result/);
  assert.match(adminCsvImport, /Paste CSV first/);
  assert.doesNotMatch(adminCsvImport, /csvImportText|\$\('csvImportText'\)/);
  assert.doesNotMatch(html, /\$\('dgsImportBtn'\)\.addEventListener|\$\('csvImportBtn'\)\.addEventListener/);
  assert.match(html, /import \{ installImportController \} from "\.\/import-controller\.js"/);
  assert.match(html, /installImportController\(adminControllerDeps\)/);
  assert.match(importController, /gvdg:admin-csv-import-request/);
  assert.match(main, /import \{ AdminImportControls \} from "\.\/import-controls\.js"/);
  assert.match(main, /const importControlsMount = document\.getElementById\("adminImportControlsReactApp"\)/);
  assert.match(main, /createRoot\(importControlsMount\)\.render\(h\(AdminImportControls\)\)/);
  assert.match(controls, /export function AdminImportControls/);
  assert.match(controls, /data-react-admin-import-controls/);
  assert.match(controls, /gvdg:admin-csv-import-request/);
  assert.match(controls, /gvdg:admin-csv-import-result/);
  assert.match(controls, /id: "csvImportText"/);
  assert.match(controls, /id: "csvImportBtn"/);
  assert.match(controls, /id: "udiscImportUrl"/);
  assert.match(controls, /id: "udiscImportBtn"/);
  assert.match(controls, /csv: csvText/);
  assert.doesNotMatch(controls, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️|🏆|⚠|⏱|⬇|✓|—/);
});
