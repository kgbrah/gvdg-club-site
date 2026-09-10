import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('admin leagues pane mounts a React league-night form', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const form = readFileSync('src/admin-app/league-night-form.js', 'utf8');
  const controller = readFileSync('src/admin-app/admin-controller.js', 'utf8');

  assert.match(html, /id="adminLeagueNightFormReactApp"/);
  assert.match(main, /import \{ AdminLeagueNightForm \} from "\.\/league-night-form\.js"/);
  assert.match(main, /createRoot\(leagueNightFormMount\)\.render\(h\(AdminLeagueNightForm\)\)/);
  assert.match(form, /export function AdminLeagueNightForm/);
  assert.match(form, /data-react-admin-league-night-form/);
  assert.match(form, /gvdg:admin-league-night-request/);
  assert.match(controller, /gvdg:admin-league-night-request/);
  assert.match(controller, /adminApi\('\/admin\/leagues\/' \+ leagueId \+ '\/nights'/);
  assert.doesNotMatch(form, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=/);
});
