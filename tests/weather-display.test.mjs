import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

async function loadWeatherDisplay() {
  const source = await readFile(new URL('../weather-display.js', import.meta.url), 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.GVDGWeather;
}

test('formats current round weather with wind, precipitation, humidity, and update time', async () => {
  const weather = await loadWeatherDisplay();
  const state = {
    location: { lat: 35.6, lng: -77.4, label: 'Course - Greenville, NC' },
    current: {
      observedAt: '2026-07-01T16:20:00.000Z',
      fetchedAt: '2026-07-01T16:20:10.000Z',
      temperatureF: 82.4,
      apparentTemperatureF: 88.2,
      precipitationIn: 0.03,
      rainIn: 0.03,
      showersIn: 0,
      snowfallIn: 0,
      relativeHumidity: 72,
      weatherCode: 61,
      windSpeedMph: 8.4,
      windDirectionDeg: 225,
      windGustMph: 18.1,
    },
    history: [],
    updatedAt: '2026-07-01T16:20:10.000Z',
  };

  const labels = Array.from(weather.weatherChips(state).map((chip) => chip.label));
  assert.deepEqual(labels, ['Conditions', 'Wind', 'Precip', 'Humidity', 'Updated']);
  assert.match(weather.formatLiveWeather(state), /Conditions: Rain 82 F feels 88 F/);
  assert.match(weather.formatLiveWeather(state), /Wind: SW 8 mph gust 18/);
  assert.match(weather.formatLiveWeather(state), /Precip: Rain 0\.03 in/);
});

function fakeDoc() {
  function el() {
    return {
      children: [], attrs: {}, style: {}, className: '', textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {},
      querySelectorAll() { return []; },
    };
  }
  return { createElement: () => el(), createElementNS: () => el(), createTextNode: (t) => ({ text: t }) };
}
function findArrow(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.attrs && node.attrs.class === 'weather-wind-arrow') return node;
  for (const k of node.children || []) { const f = findArrow(k); if (f) return f; }
  return null;
}

test('wind chip includes a direction arrow pointing where the wind blows (north-up until compass enabled)', async () => {
  const weather = await loadWeatherDisplay();
  const state = { current: { windSpeedMph: 8.4, windDirectionDeg: 225, windGustMph: 10 }, history: [] };
  const strip = weather.buildWeatherStrip(fakeDoc(), state, {});
  const arrow = findArrow(strip);
  assert.ok(arrow, 'wind arrow present');
  assert.equal(arrow.getAttribute('data-blowto'), '45'); // wind FROM 225 (SW) blows TO 45 (NE)
  assert.equal(arrow.getAttribute('data-relative'), 'north'); // compass off -> north-up
  assert.equal(arrow.style.transform, 'rotate(45deg)');
});

test('no wind arrow when direction is unknown', async () => {
  const weather = await loadWeatherDisplay();
  const state = { current: { windSpeedMph: 5, windDirectionDeg: null }, history: [] };
  assert.equal(findArrow(weather.buildWeatherStrip(fakeDoc(), state, {})), null);
});

test('surfaces material weather changes during a round', async () => {
  const weather = await loadWeatherDisplay();
  const previous = {
    observedAt: '2026-07-01T16:10:00.000Z',
    fetchedAt: '2026-07-01T16:10:10.000Z',
    precipitationIn: 0,
    rainIn: 0,
    windSpeedMph: 4,
    windGustMph: 8,
    weatherCode: 2,
  };
  const current = {
    observedAt: '2026-07-01T16:20:00.000Z',
    fetchedAt: '2026-07-01T16:20:10.000Z',
    precipitationIn: 0.02,
    rainIn: 0.02,
    windSpeedMph: 9,
    windGustMph: 17,
    weatherCode: 61,
  };

  assert.deepEqual(
    Array.from(weather.weatherChanges({ current, history: [previous, current] })),
    ['Wind +5 mph', 'Gust +9 mph', 'Rain started'],
  );
});
