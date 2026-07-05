import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

async function loadWeatherDisplay(globals = {}) {
  const source = await readFile(new URL('../weather-display.js', import.meta.url), 'utf8');
  const context = { ...globals };
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

test('maps open-meteo weather codes to accessible condition graphics', async () => {
  const weather = await loadWeatherDisplay();
  const cases = [
    [{ weatherCode: 0, isDay: true }, '☀️', 'Clear'],
    [{ weatherCode: 0, isDay: false }, '🌙', 'Clear'],
    [{ weatherCode: 2 }, '⛅', 'Partly cloudy'],
    [{ weatherCode: 45 }, '🌫️', 'Fog'],
    [{ weatherCode: 63 }, '🌧️', 'Rain'],
    [{ weatherCode: 71 }, '❄️', 'Light snow'],
    [{ weatherCode: 85 }, '🌨️', 'Snow showers'],
    [{ weatherCode: 95 }, '⛈️', 'Thunderstorm'],
    [{ weatherCode: null, precipitationIn: 0.03 }, '🌧️', 'Rain'],
    [{ weatherCode: 2, precipitationIn: 0.03 }, '🌧️', 'Rain'],
  ];
  for (const [input, icon, label] of cases) {
    const graphic = weather.conditionGraphic(input);
    assert.equal(graphic.icon, icon);
    assert.equal(graphic.label, label);
  }
});

function fakeDoc() {
  function el() {
    return {
      children: [], attrs: {}, style: {}, className: '', textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {},
      querySelector(selector) { return selector.startsWith('.') ? findByClass(this, selector.slice(1)) : null; },
      querySelectorAll() { return []; },
    };
  }
  return { createElement: () => el(), createElementNS: () => el(), createTextNode: (t) => ({ text: t }) };
}

function nodeClass(node) {
  return (node && node.className) || (node && node.attrs && node.attrs.class) || '';
}

function findByClass(node, className) {
  if (!node || typeof node !== 'object') return null;
  if (nodeClass(node).split(/\s+/).includes(className)) return node;
  for (const child of node.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function findArrow(node) {
  return findByClass(node, 'weather-wind-arrow');
}

function textOf(node) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];
  if (node.textContent) parts.push(node.textContent);
  if (node.text) parts.push(node.text);
  for (const child of node.children || []) {
    const childText = textOf(child);
    if (childText) parts.push(childText);
  }
  return parts.join(' ');
}

test('compact weather strip promotes condition, wind, and secondary meta without chip clutter', async () => {
  const weather = await loadWeatherDisplay();
  const state = {
    location: { label: 'Course - Greenville, NC' },
    current: {
      observedAt: '2026-07-01T16:20:00.000Z',
      fetchedAt: '2026-07-01T16:20:10.000Z',
      temperatureF: 82.4,
      apparentTemperatureF: 88.2,
      precipitationIn: 0.03,
      rainIn: 0.03,
      relativeHumidity: 72,
      weatherCode: 61,
      windSpeedMph: 8.4,
      windDirectionDeg: 225,
      windGustMph: 18.1,
    },
    history: [],
    updatedAt: '2026-07-01T16:20:10.000Z',
  };

  const strip = weather.buildWeatherStrip(fakeDoc(), state, {});
  assert.equal(findByClass(strip, 'weather-temp').textContent, '82°');
  assert.match(textOf(findByClass(strip, 'weather-copy')), /Rain/);
  assert.match(textOf(findByClass(strip, 'weather-copy')), /Feels 88°/);
  const graphic = findByClass(strip, 'weather-graphic');
  assert.equal(graphic.getAttribute('role'), 'img');
  assert.equal(graphic.getAttribute('aria-label'), 'Light rain');
  assert.match(textOf(graphic), /🌧️/);
  assert.match(textOf(findByClass(strip, 'weather-wind')), /SW 8 mph/);
  assert.match(textOf(findByClass(strip, 'weather-wind')), /gust 18/);
  assert.match(textOf(findByClass(strip, 'weather-wind')), /North-up/);
  assert.match(textOf(findByClass(strip, 'weather-meta')), /Humidity 72%/);
  assert.match(textOf(findByClass(strip, 'weather-meta')), /Rain 0\.03 in/);
  assert.match(textOf(strip), /Course - Greenville, NC/);
});

test('wind control includes a direction arrow pointing where the wind blows north-up until compass enabled', async () => {
  const weather = await loadWeatherDisplay();
  const state = { current: { windSpeedMph: 8.4, windDirectionDeg: 225, windGustMph: 10 }, history: [] };
  const strip = weather.buildWeatherStrip(fakeDoc(), state, {});
  const arrow = findArrow(strip);
  assert.ok(arrow, 'wind arrow present');
  assert.equal(arrow.getAttribute('data-blowto'), '45'); // wind FROM 225 (SW) blows TO 45 (NE)
  assert.equal(arrow.getAttribute('data-relative'), 'north'); // compass off -> north-up
  assert.equal(arrow.style.transform, 'rotate(45deg)');
});

test('wind arrow rotates relative to device heading after compass permission', async () => {
  const listeners = {};
  let requestedAbsolute = null;
  let clearedTimer = false;
  const fakeWindow = {
    DeviceOrientationEvent: {
      requestPermission(absolute) {
        requestedAbsolute = absolute;
        return Promise.resolve('granted');
      },
    },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    setTimeout() { return 1; },
    clearTimeout() { clearedTimer = true; },
  };
  const weather = await loadWeatherDisplay({ window: fakeWindow });

  assert.equal(await weather.enableCompass(), true);
  assert.equal(requestedAbsolute, true);
  assert.equal(typeof listeners.deviceorientationabsolute, 'function');
  assert.equal(typeof listeners.deviceorientation, 'function');

  listeners.deviceorientation({ absolute: true, alpha: 90 });
  const strip = weather.buildWeatherStrip(fakeDoc(), { current: { windSpeedMph: 8.4, windDirectionDeg: 225, windGustMph: 10 }, history: [] }, {});
  const arrow = findArrow(strip);
  const wind = findByClass(strip, 'weather-wind');
  assert.equal(clearedTimer, true);
  assert.equal(arrow.getAttribute('data-relative'), 'facing');
  assert.equal(arrow.getAttribute('data-compass-status'), 'active');
  assert.equal(arrow.style.transform, 'rotate(135deg)');
  assert.equal(wind.getAttribute('data-relative'), 'facing');
  assert.match(textOf(wind), /Phone-relative/);
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
