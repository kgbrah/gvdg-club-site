import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('tee-sign preview is rendered by a route-specific React bundle', () => {
  const html = readFileSync('tee-sign-preview.html', 'utf8');
  const packageJson = readFileSync('package.json', 'utf8');
  const app = readFileSync('src/tee-sign-preview-app/main.js', 'utf8');
  const deploy = readFileSync('scripts/gvdg-deploy.sh', 'utf8');
  const watchdog = readFileSync('scripts/gvdg-deploy-watchdog.sh', 'utf8');
  const workflow = readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
  const sw = readFileSync('sw.js', 'utf8');

  assert.ok(existsSync('vite.tee-sign-preview.config.mjs'));
  assert.match(packageJson, /"build:tee-sign-preview": "vite build --config vite\.tee-sign-preview\.config\.mjs"/);
  assert.match(packageJson, /"build": "npm run build:home && npm run build:public && npm run build:tee-sign-preview && npm run build:score && npm run build:members"/);
  assert.match(html, /id="teeSignPreviewReactApp"/);
  assert.match(html, /<script type="module" src="tee-sign-preview-app\/tee-sign-preview-app\.js"><\/script>/);
  assert.match(html, /tokens\.css/);
  assert.doesNotMatch(html, /id="toggle"|id="grid"|import \{ teeSignNode \}|document\.getElementById|document\.createElement|appendChild|addEventListener/);
  assert.match(app, /export function TeeSignPreviewApp/);
  assert.match(app, /data-react-tee-sign-preview/);
  assert.match(app, /teeSignNode\(sample\)/);
  assert.match(app, /replaceChildren/);
  assert.match(app, /MoonStar, Sun/);
  assert.match(deploy, /home-app public-app tee-sign-preview-app members-app score-app/);
  assert.match(watchdog, /home-app public-app tee-sign-preview-app members-app score-app/);
  assert.match(workflow, /home-app public-app tee-sign-preview-app members-app score-app/);
  assert.match(sw, /const CACHE = "gvdg-club-v59"/);
  assert.match(sw, /"tee-sign-preview-app\/tee-sign-preview-app\.js"/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️/);
});
