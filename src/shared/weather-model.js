"use strict";

const CODES = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    56: "Freezing drizzle",
    57: "Heavy freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Light showers",
    81: "Showers",
    82: "Heavy showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Heavy thunderstorm with hail",
};
const DIRECTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value) {
    const n = finite(value);
    return n == null ? null : Math.round(n);
}

function signed(value) {
    const n = round(value);
    if (n == null) return null;
    return n > 0 ? "+" + n : String(n);
}

function direction(deg) {
    const n = finite(deg);
    if (n == null) return null;
    return DIRECTIONS[Math.round((((n % 360) + 360) % 360) / 22.5) % 16];
}

// ---- wind-direction arrow, relative to the player's facing ------------------------------------------
// Open-Meteo windDirectionDeg is the compass bearing the wind blows FROM. An arrow is most useful to a
// disc golfer pointing where the wind PUSHES the disc (blow-to = from + 180). When the compass is
// enabled we rotate that relative to the phone's heading, so screen-up = the way the player is facing:
// arrow up = tailwind, down = headwind, sideways = crosswind. Without the compass the arrow is north-up.
let compassHeading = null; // player facing, degrees (0 = N, clockwise); null = unknown -> arrow is north-up
let compassEnabled = false;
let compassStatus = "off"; // off | starting | active | denied | unavailable
let compassFallbackTimer = null;
const compassListeners = new Set();

function normalizeDeg(value) {
    const n = finite(value);
    return n == null ? null : ((n % 360) + 360) % 360;
}

function compassModeText() {
    if (compassHeading != null) return "Phone-relative";
    if (compassStatus === "starting") return "Listening...";
    if (compassStatus === "denied") return "Permission off";
    return "North-up";
}

export function compassState() {
    return {
        heading: compassHeading,
        modeText: compassModeText(),
        relative: compassHeading == null ? "north" : "facing",
        status: compassStatus,
    };
}

function notifyCompass() {
    const state = compassState();
    compassListeners.forEach(function (listener) {
        try { listener(state); } catch (_err) {}
    });
}

export function subscribeCompass(listener) {
    if (typeof listener !== "function") return function () {};
    compassListeners.add(listener);
    listener(compassState());
    return function () {
        compassListeners.delete(listener);
    };
}

function windArrowState(blowToDeg) {
    const blowTo = normalizeDeg(blowToDeg);
    if (blowTo == null) return null;
    const rotationDeg = normalizeDeg(blowTo - (compassHeading == null ? 0 : compassHeading));
    const relative = compassHeading == null ? "north" : "facing";
    return {
        blowTo,
        compassStatus,
        label: relative === "north"
            ? "Wind blowing this way. Tap to orient it to your phone heading."
            : "Wind blowing this way, relative to the way you're facing",
        modeText: compassModeText(),
        relative,
        rotationDeg,
    };
}

export function windArrowModel(windFromDeg) {
    const windFrom = finite(windFromDeg);
    return windArrowState(windFrom == null ? null : windFrom + 180);
}

function onOrientation(event) {
    let heading = null;
    if (typeof event.webkitCompassHeading === "number" && Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0) {
        heading = event.webkitCompassHeading; // iOS: already a compass heading (0 = N, clockwise)
    } else if (event.absolute === true && typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
        heading = 360 - event.alpha; // Android absolute orientation -> compass heading of the device top
    }
    if (heading == null) return;
    compassHeading = normalizeDeg(heading);
    compassStatus = "active";
    if (compassFallbackTimer != null && typeof window !== "undefined" && window.clearTimeout) {
        window.clearTimeout(compassFallbackTimer);
        compassFallbackTimer = null;
    }
    notifyCompass();
}

// Start (once) listening to the device compass so the arrow tracks the player's facing. iOS 13+ requires
// this be triggered from a user gesture (we call it from the wind control click). Returns a Promise<boolean>.
export async function enableCompass() {
    if (compassEnabled) return true;
    if (typeof window === "undefined") return false;
    const attach = function () {
        compassEnabled = true;
        compassStatus = "starting";
        window.addEventListener("deviceorientationabsolute", onOrientation, true);
        window.addEventListener("deviceorientation", onOrientation, true);
        if (window.setTimeout) {
            compassFallbackTimer = window.setTimeout(function () {
                if (compassHeading == null) {
                    compassStatus = "unavailable";
                    notifyCompass();
                }
            }, 3000);
        }
        notifyCompass();
        return true;
    };
    try {
        const DOE = window.DeviceOrientationEvent;
        if (DOE && typeof DOE.requestPermission === "function") {
            let permission;
            try { permission = DOE.requestPermission(true); } // request magnetometer-backed absolute orientation when supported
            catch (_err) { permission = DOE.requestPermission(); }
            try {
                const res = await Promise.resolve(permission);
                if (res === "granted") return attach();
                compassStatus = "denied";
                notifyCompass();
                return false;
            } catch (_err) {
                compassStatus = "denied";
                notifyCompass();
                return false;
            }
        }
        return attach();
    } catch (_e) {
        compassStatus = "unavailable";
        notifyCompass();
        return false;
    }
}

function inch(value) {
    const n = finite(value);
    if (n == null) return null;
    if (n > 0 && n < 0.01) return "<0.01 in";
    return n.toFixed(2).replace(/\.?0+$/, "") + " in";
}

export function conditionLabel(current) {
    if (!current) return null;
    const snow = finite(current.snowfallIn);
    const rain = Math.max(
        finite(current.rainIn) || 0,
        finite(current.showersIn) || 0,
        finite(current.precipitationIn) || 0,
    );
    if (snow && snow > 0) return "Snow";
    if (rain > 0) return "Rain";
    return CODES[current.weatherCode] || "Current";
}

export function conditionGraphic(current) {
    if (!current) return null;
    const code = finite(current.weatherCode);
    const label = code == null
        ? conditionLabel(current) || "Current conditions"
        : CODES[code] || conditionLabel(current) || "Current conditions";
    const snow = finite(current.snowfallIn);
    const rain = Math.max(
        finite(current.rainIn) || 0,
        finite(current.showersIn) || 0,
        finite(current.precipitationIn) || 0,
    );
    if (code >= 95 && code <= 99) return { icon: "⛈️", label };
    if (code >= 85 && code <= 86) return { icon: "🌨️", label };
    if (code >= 71 && code <= 77) return { icon: "❄️", label };
    if (snow && snow > 0) return { icon: "❄️", label: "Snow" };
    if (code >= 51 && code <= 57) return { icon: "🌦️", label };
    if (code >= 61 && code <= 67) return { icon: "🌧️", label };
    if (code >= 80 && code <= 82) return { icon: "🌦️", label };
    if (rain > 0) return { icon: "🌧️", label: "Rain" };
    if (code === 0) return { icon: current.isDay === false ? "🌙" : "☀️", label };
    if (code === 1) return { icon: current.isDay === false ? "🌙" : "🌤️", label };
    if (code === 2) return { icon: "⛅", label };
    if (code === 3) return { icon: "☁️", label };
    if (code === 45 || code === 48) return { icon: "🌫️", label };
    return { icon: "🌡️", label };
}

function precipAmount(current) {
    if (!current) return 0;
    return Math.max(
        finite(current.precipitationIn) || 0,
        finite(current.rainIn) || 0,
        finite(current.showersIn) || 0,
        finite(current.snowfallIn) || 0,
    );
}

function precipLabel(current) {
    if (!current) return null;
    const snow = finite(current.snowfallIn);
    const rain = Math.max(
        finite(current.rainIn) || 0,
        finite(current.showersIn) || 0,
        finite(current.precipitationIn) || 0,
    );
    if (snow && snow > 0) return "Snow " + inch(snow);
    if (rain > 0) return "Rain " + inch(rain);
    return null;
}

function timeLabel(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function previousSample(weather, current) {
    const history = weather && Array.isArray(weather.history) ? weather.history : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const sample = history[i];
        if (!sample || sample === current) continue;
        if (sample.observedAt !== current.observedAt || sample.fetchedAt !== current.fetchedAt) return sample;
    }
    return null;
}

export function weatherChanges(weather) {
    const current = weather && weather.current;
    if (!current) return [];
    const prev = previousSample(weather, current);
    if (!prev) return [];

    const changes = [];
    const windNow = finite(current.windSpeedMph);
    const windPrev = finite(prev.windSpeedMph);
    if (windNow != null && windPrev != null && Math.abs(windNow - windPrev) >= 2) {
        changes.push("Wind " + signed(windNow - windPrev) + " mph");
    }

    const gustNow = finite(current.windGustMph);
    const gustPrev = finite(prev.windGustMph);
    if (gustNow != null && gustPrev != null && Math.abs(gustNow - gustPrev) >= 5) {
        changes.push("Gust " + signed(gustNow - gustPrev) + " mph");
    }

    const wetNow = precipAmount(current);
    const wetPrev = precipAmount(prev);
    if (wetNow > 0 && wetPrev === 0) changes.push("Rain started");
    else if (wetNow === 0 && wetPrev > 0) changes.push("Rain stopped");
    else if (wetNow > 0 && Math.abs(wetNow - wetPrev) >= 0.01) {
        changes.push("Precip " + (wetNow > wetPrev ? "+" : "") + inch(wetNow - wetPrev));
    }

    const nowCondition = conditionLabel(current);
    const prevCondition = conditionLabel(prev);
    if (nowCondition && prevCondition && nowCondition !== prevCondition && changes.length < 3) {
        changes.push("Was " + prevCondition);
    }
    return changes.slice(0, 3);
}

export function weatherChips(weather) {
    const current = weather && weather.current;
    if (!current) {
        if (weather && weather.error) return [{ label: "Weather", value: "Unavailable" }];
        if (weather) return [{ label: "Weather", value: "Pending" }];
        return [];
    }

    const chips = [];
    const temp = round(current.temperatureF);
    const feels = round(current.apparentTemperatureF);
    const condition = conditionLabel(current);
    let conditions = condition || "Current";
    if (temp != null) conditions += " " + temp + " F";
    if (feels != null && temp != null && Math.abs(feels - temp) >= 4) conditions += " feels " + feels + " F";
    chips.push({ label: "Conditions", value: conditions });

    const wind = round(current.windSpeedMph);
    if (wind != null) {
        const dir = direction(current.windDirectionDeg);
        let text = (dir ? dir + " " : "") + wind + " mph";
        const gust = round(current.windGustMph);
        if (gust != null && gust > wind + 2) text += " gust " + gust;
        chips.push({ label: "Wind", value: text });
    }

    const precip = precipLabel(current);
    if (precip) chips.push({ label: "Precip", value: precip });

    const humidity = round(current.relativeHumidity);
    if (humidity != null) chips.push({ label: "Humidity", value: humidity + "%" });

    const changes = weatherChanges(weather);
    if (changes.length) chips.push({ label: "Change", value: changes.join(" | ") });

    // Use fetchedAt / updatedAt (real UTC instants, "…Z") for the localized "Updated" clock. observedAt
    // is Open-Meteo's course-local time WITHOUT an offset (e.g. "2026-07-03T14:15"), which new Date()
    // reads as the VIEWER's local time — so a spectator in another timezone would see a wrong (even
    // future) time. observedAt is only a last resort if no real instant is available.
    const observed = timeLabel(current.fetchedAt) || timeLabel(weather.updatedAt) || timeLabel(current.observedAt);
    if (observed) chips.push({ label: "Updated", value: observed });
    return chips;
}

export function currentWeatherSummary(weather) {
    const current = weather && weather.current;
    if (!current) return null;
    const temp = round(current.temperatureF);
    const feels = round(current.apparentTemperatureF);
    const condition = conditionLabel(current) || "Current";
    const wind = round(current.windSpeedMph);
    const gust = round(current.windGustMph);
    const windDir = direction(current.windDirectionDeg);
    const humidity = round(current.relativeHumidity);
    const precip = precipLabel(current);
    const observed = timeLabel(current.fetchedAt) || timeLabel(weather.updatedAt) || timeLabel(current.observedAt);
    return {
        condition,
        tempText: temp == null ? "--" : temp + "°",
        feelsText: feels != null && temp != null && Math.abs(feels - temp) >= 4 ? "Feels " + feels + "°" : null,
        windText: wind == null ? null : (windDir ? windDir + " " : "") + wind + " mph",
        gustText: gust != null && wind != null && gust > wind + 2 ? "gust " + gust : null,
        humidityText: humidity == null ? null : "Humidity " + humidity + "%",
        precipText: precip,
        changes: weatherChanges(weather),
        graphic: conditionGraphic(current),
        updatedText: observed ? "Updated " + observed : null,
    };
}

export function formatLiveWeather(weather) {
    return weatherChips(weather).map((chip) => chip.label + ": " + chip.value).join(" - ");
}

const OPEN_METEO_CURRENT_FIELDS = [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "rain",
    "showers",
    "snowfall",
    "weather_code",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "is_day",
];
const WEATHER_UA = "GreenvilleDiscGolfClub/1.0 (https://gvdgclub.com; weather@gvdgclub.com)";
const FALLBACK_TTL_MS = 5 * 60 * 1000;
const fallbackCache = new Map();

function finiteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function round1(value) {
    const n = finiteNumber(value);
    return n == null ? null : Math.round(n * 10) / 10;
}

function round2(value) {
    const n = finiteNumber(value);
    return n == null ? null : Math.round(n * 100) / 100;
}

function nwsUnitValue(value) {
    if (value && typeof value === "object") return finiteNumber(value.value);
    return finiteNumber(value);
}

function nwsWeatherCode(text) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    if (/thunder|t-?storm/.test(t)) return 95;
    if (/\bsnow|sleet|ice|wintry/.test(t)) return 71;
    if (/\bfog|mist|haze/.test(t)) return 45;
    if (/drizzle/.test(t)) return 51;
    if (/shower/.test(t)) return 80;
    if (/\brain/.test(t)) return /heavy/.test(t) ? 65 : /light/.test(t) ? 61 : 63;
    if (/overcast/.test(t) || /mostly cloudy/.test(t)) return 3;
    if (/partly cloudy|partly sunny/.test(t)) return 2;
    if (/mostly clear|mostly sunny|fair/.test(t)) return 1;
    if (/clear|sunny/.test(t)) return 0;
    if (/cloud/.test(t)) return 3;
    return null;
}

export function parseOpenMeteoCurrent(payload, fetchedAt) {
    const current = payload && payload.current;
    if (!current || typeof current !== "object") return null;
    const isDay = finiteNumber(current.is_day);
    return {
        source: "open-meteo",
        observedAt: typeof current.time === "string" && current.time ? current.time : fetchedAt,
        fetchedAt,
        temperatureF: round1(current.temperature_2m),
        apparentTemperatureF: round1(current.apparent_temperature),
        relativeHumidity: round1(current.relative_humidity_2m),
        precipitationIn: round2(current.precipitation),
        rainIn: round2(current.rain),
        showersIn: round2(current.showers),
        snowfallIn: round2(current.snowfall),
        weatherCode: finiteNumber(current.weather_code),
        cloudCover: round1(current.cloud_cover),
        windSpeedMph: round1(current.wind_speed_10m),
        windDirectionDeg: round1(current.wind_direction_10m),
        windGustMph: round1(current.wind_gusts_10m),
        isDay: isDay == null ? null : isDay > 0,
    };
}

export function parseNwsObservation(payload, fetchedAt) {
    const props = payload && payload.properties && typeof payload.properties === "object"
        ? payload.properties
        : payload;
    if (!props || typeof props !== "object") return null;
    const celsius = nwsUnitValue(props.temperature);
    if (celsius == null) return null;
    const precipIn = round2(nwsUnitValue(props.precipitationLastHour) == null ? null : nwsUnitValue(props.precipitationLastHour) / 25.4);
    const heatC = nwsUnitValue(props.heatIndex);
    return {
        source: "nws",
        observedAt: typeof props.timestamp === "string" && props.timestamp ? props.timestamp : fetchedAt,
        fetchedAt,
        temperatureF: round1(celsius * 9 / 5 + 32),
        apparentTemperatureF: heatC == null ? round1(celsius * 9 / 5 + 32) : round1(heatC * 9 / 5 + 32),
        relativeHumidity: round1(nwsUnitValue(props.relativeHumidity)),
        precipitationIn: precipIn,
        rainIn: precipIn != null && precipIn > 0 ? precipIn : 0,
        showersIn: 0,
        snowfallIn: 0,
        weatherCode: nwsWeatherCode(props.textDescription),
        cloudCover: null,
        windSpeedMph: round1(nwsUnitValue(props.windSpeed) == null ? null : nwsUnitValue(props.windSpeed) * 0.621371),
        windDirectionDeg: round1(nwsUnitValue(props.windDirection)),
        windGustMph: round1(nwsUnitValue(props.windGust) == null ? null : nwsUnitValue(props.windGust) * 0.621371),
        isDay: null,
    };
}

function openMeteoUrl(location) {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", Number(location.lat).toFixed(6));
    url.searchParams.set("longitude", Number(location.lng).toFixed(6));
    url.searchParams.set("current", OPEN_METEO_CURRENT_FIELDS.join(","));
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "1");
    return url;
}

async function readJson(doFetch, url, headers) {
    try {
        const response = await doFetch(url, { headers });
        if (!response || !response.ok) return null;
        return await response.json();
    } catch (_err) {
        return null;
    }
}

async function fetchNwsObservation(location, doFetch, fetchedAt) {
    const headers = { Accept: "application/geo+json", "User-Agent": WEATHER_UA };
    const points = await readJson(
        doFetch,
        "https://api.weather.gov/points/" + Number(location.lat).toFixed(4) + "," + Number(location.lng).toFixed(4),
        headers,
    );
    const stationsUrl = points && points.properties && points.properties.observationStations;
    if (!stationsUrl) return null;
    const stations = await readJson(doFetch, stationsUrl, headers);
    const feature = stations && Array.isArray(stations.features) ? stations.features[0] : null;
    const stationId = feature && feature.properties && feature.properties.stationIdentifier
        || (typeof feature?.id === "string" ? (feature.id.match(/stations\/([A-Z0-9]+)$/i) || [])[1] : null);
    if (!stationId) return null;
    const observation = await readJson(doFetch, "https://api.weather.gov/stations/" + stationId + "/observations/latest", headers);
    return parseNwsObservation(observation, fetchedAt);
}

function locationKey(location) {
    return Number(location.lat).toFixed(4) + "," + Number(location.lng).toFixed(4);
}

export async function fetchCourseWeather(location, doFetch = fetch) {
    if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) return null;
    const key = locationKey(location);
    const cached = fallbackCache.get(key);
    if (cached && cached.sample && Date.now() - cached.at < FALLBACK_TTL_MS) return cached.sample;
    if (cached && cached.inflight) return cached.inflight;

    const inflight = (async function () {
        const fetchedAt = new Date().toISOString();
        const om = parseOpenMeteoCurrent(await readJson(doFetch, openMeteoUrl(location), {
            Accept: "application/json",
            "User-Agent": WEATHER_UA,
        }), fetchedAt);
        const sample = om || await fetchNwsObservation(location, doFetch, fetchedAt);
        fallbackCache.set(key, { at: Date.now(), sample: sample || null });
        return sample || null;
    })();

    fallbackCache.set(key, { ...(cached || {}), inflight, at: cached ? cached.at : 0, sample: cached ? cached.sample : null });
    try {
        return await inflight;
    } finally {
        const cur = fallbackCache.get(key);
        if (cur) delete cur.inflight;
    }
}

export function mergeFallbackWeather(weather, sample) {
    if (!weather || !sample) return weather || null;
    return {
        ...weather,
        current: sample,
        error: null,
        updatedAt: sample.fetchedAt || weather.updatedAt,
    };
}

