import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const fixture = "virtual:scorer-weather-states";
const { output } = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "weather-states-fixture",
    resolveId: (id) => id === fixture ? "\0" + fixture : null,
    load: (id) => id === "\0" + fixture ? `
      import React from "react";
      import { flushSync } from "react-dom";
      import { createRoot } from "react-dom/client";
      import { WeatherStrip } from ${JSON.stringify(resolve("src/score-app/weather-strip.js"))};
      const root = createRoot(document.querySelector("main"));
      window.showWeather = (weather, props) => flushSync(() => root.render(React.createElement(WeatherStrip, { weather, ...props })));
    ` : null,
  }],
  build: { write: false, rolldownOptions: { input: fixture, output: { entryFileNames: "weather-fixture.js" } } },
});
const bundle = output.find((item) => item.type === "chunk" && item.isEntry).code;
const server = createServer((request, response) => {
  if (request.url === "/weather-fixture.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle);
  } else {
    response.writeHead(200, { "Content-Type": "text/html" }).end(
      '<title>Weather states QA</title><main></main><script type="module" src="/weather-fixture.js"></script>',
    );
  }
});
await new Promise((listen) => server.listen(0, "127.0.0.1", listen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const requests = [];
const fixtures = new Map();
let offline = false;
const data = (temperature) => ({ current: { temperature_2m: temperature, weather_code: 2,
  wind_speed_10m: 8, wind_direction_10m: 292, wind_gusts_10m: 13 } });
const locationWeather = (lat, label = `Course ${lat}`) => ({ location: { lat, lng: -82.125, label }, current: null, error: null });

function provider(lat) {
  let respond;
  let complete;
  const response = new Promise((ready) => { respond = ready; });
  const started = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.hostname === "api.open-meteo.com" && Number(url.searchParams.get("latitude")) === lat;
  });
  const completed = new Promise((ready) => { complete = ready; });
  fixtures.set(lat, { response, complete });
  return { started, respond, completed };
}

await context.route(/^https?:\/\//, async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin) return route.continue();
  requests.push(url);
  if (offline) return route.abort("internetdisconnected");
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (url.hostname === "api.open-meteo.com") {
    const fixture = fixtures.get(Number(url.searchParams.get("latitude")));
    assert.ok(fixture, "Unexpected forecast request for " + url);
    const sample = await fixture.response;
    await route.fulfill({ status: sample ? 200 : 503, json: sample || {}, headers: cors });
    fixture.complete();
    return;
  }
  if (url.hostname === "api.weather.gov") return route.fulfill({ status: 503, json: {}, headers: cors });
  return route.abort();
});

async function show(weather, props = { scorecard: true }) {
  await page.evaluate(({ weather, props }) => window.showWeather(weather, props), { weather, props });
}
const scorecard = page.getByRole("region", { name: "Round weather" });
const text = (value) => scorecard.getByText(value, { exact: true });
async function unavailable() {
  await text("Weather unavailable").waitFor();
  await text("Wind unavailable").waitFor();
  assert.equal(await text("Checking weather…").count(), 0);
}
async function pending() {
  await text("Checking weather…").waitFor();
  await text("Wind pending").waitFor();
}

try {
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.showWeather === "function");
  await show(null);
  await unavailable();
  for (const location of [null, { lat: null, lng: null }, { lat: "", lng: " " }, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }]) {
    await show({ location, current: null });
    await unavailable();
  }
  assert.equal(requests.length, 0, "Missing/invalid coordinates do not start an off-course request");

  const saved = provider(35.11);
  await show(locationWeather("35.11", "Original course label"));
  await saved.started;
  await pending();
  saved.respond(data(61));
  await text("61°").waitFor();
  await text("Wind WNW 8 mph").waitFor();
  await text("Gusts 13 mph").waitFor();
  await show(locationWeather(35.11, "Updated course label"), { compact: false });
  await page.locator(".weather-note").getByText("Updated course label").waitFor();
  await page.locator(".weather-wind").getByText("WNW 8 mph", { exact: true }).waitFor();
  assert.equal(requests.length, 1, "Updating metadata for the same coordinates reuses the current observation");

  const earlier = provider(35.22);
  await show(locationWeather(35.22));
  await earlier.started;
  await pending();
  assert.equal(await text("61°").count(), 0, "An already resolved observation does not flash on another course");
  const failed = provider(35.33);
  await show(locationWeather(35.33));
  await failed.started;
  earlier.respond(data(81));
  await earlier.completed;
  await pending();
  assert.equal(await text("81°").count(), 0, "A late response cannot replace the selected course");
  failed.respond(null);
  await unavailable();
  assert.ok(requests.some((url) => url.hostname === "api.weather.gov"));
  await show(locationWeather(35.33), { compact: true });
  await page.locator(".weather-strip-compact").getByText("Unavailable", { exact: true }).waitFor();

  const current = provider(35.44);
  await show(locationWeather(35.44));
  await current.started;
  await show({ ...locationWeather(35.44), current: { temperatureF: 72, weatherCode: 0 } });
  await text("72°").waitFor();
  await text("Wind unavailable").waitFor();
  assert.equal(await scorecard.locator(".weather-wind").count(), 0);
  current.respond(data(95));
  await current.completed;
  await text("72°").waitFor();
  assert.equal(await text("95°").count(), 0, "Authoritative weather supersedes an in-flight fallback");
  await show({ ...locationWeather(35.44), current: { temperatureF: 72, weatherCode: 0, windSpeedMph: 0, windGustMph: null } });
  await text("Wind 0 mph").waitFor();
  assert.equal(await scorecard.getByText(/Gusts/).count(), 0);

  offline = true;
  await context.setOffline(true);
  await show(locationWeather(35.55));
  await unavailable();
  await show(null, { compact: true });
  assert.equal(await page.locator(".weather-strip, .scorecard-weather").count(), 0);
  console.log("Weather loading, settled failures and offline, course changes, server priority, and shared callers passed.");
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
