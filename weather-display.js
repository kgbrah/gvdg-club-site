(function (root) {
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

    function inch(value) {
        const n = finite(value);
        if (n == null) return null;
        if (n > 0 && n < 0.01) return "<0.01 in";
        return n.toFixed(2).replace(/\.?0+$/, "") + " in";
    }

    function conditionLabel(current) {
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

    function weatherChanges(weather) {
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

    function weatherChips(weather) {
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

    function formatLiveWeather(weather) {
        return weatherChips(weather).map((chip) => chip.label + ": " + chip.value).join(" - ");
    }

    function buildWeatherStrip(doc, weather, options) {
        const chips = weatherChips(weather);
        if (!chips.length) return null;
        const opts = options || {};
        const wrap = doc.createElement("div");
        wrap.className = "weather-strip";

        const title = doc.createElement("div");
        title.className = "weather-title";
        title.textContent = opts.title || "Round weather";
        wrap.appendChild(title);

        const row = doc.createElement("div");
        row.className = "weather-chips";
        chips.forEach((chip) => {
            const item = doc.createElement("span");
            item.className = "weather-chip";
            const label = doc.createElement("strong");
            label.textContent = chip.label;
            item.appendChild(label);
            item.appendChild(doc.createTextNode(chip.value));
            row.appendChild(item);
        });
        wrap.appendChild(row);

        if (weather && weather.location && weather.location.label) {
            const note = doc.createElement("div");
            note.className = "weather-note";
            note.textContent = weather.location.label;
            wrap.appendChild(note);
        }

        return wrap;
    }

    function renderWeather(container, weather, options) {
        if (!container) return;
        container.replaceChildren();
        const node = buildWeatherStrip(container.ownerDocument || document, weather, options);
        container.hidden = !node;
        if (node) container.appendChild(node);
    }

    root.GVDGWeather = {
        buildWeatherStrip,
        conditionLabel,
        formatLiveWeather,
        renderWeather,
        weatherChanges,
        weatherChips,
    };
})(typeof globalThis !== "undefined" ? globalThis : window);
