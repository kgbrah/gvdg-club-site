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

    // ---- wind-direction arrow, relative to the player's facing ------------------------------------------
    // Open-Meteo windDirectionDeg is the compass bearing the wind blows FROM. An arrow is most useful to a
    // disc golfer pointing where the wind PUSHES the disc (blow-to = from + 180). When the compass is
    // enabled we rotate that relative to the phone's heading, so screen-up = the way the player is facing:
    // arrow up = tailwind, down = headwind, sideways = crosswind. Without the compass the arrow is north-up.
    const ARROW_NS = "http://www.w3.org/2000/svg";
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

    function compassState() {
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

    function subscribeCompass(listener) {
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

    function windArrowModel(windFromDeg) {
        const windFrom = finite(windFromDeg);
        return windArrowState(windFrom == null ? null : windFrom + 180);
    }

    function applyArrowRotation(arrow) {
        const model = windArrowState(Number(arrow.getAttribute("data-blowto")));
        if (!model) return;
        arrow.style.transform = "rotate(" + model.rotationDeg + "deg)";
        arrow.setAttribute("data-relative", model.relative);
        arrow.setAttribute("data-compass-status", model.compassStatus);
        arrow.setAttribute("aria-label", model.label);
        if (arrow.__titleEl) arrow.__titleEl.textContent = model.label;
        const control = arrow.__windControl || arrow.closest && arrow.closest(".weather-wind");
        if (control) {
            control.setAttribute("data-relative", model.relative);
            control.setAttribute("data-compass-status", model.compassStatus);
            control.setAttribute("aria-label", model.label);
            const mode = control.querySelector && control.querySelector(".weather-wind-mode");
            if (mode) mode.textContent = model.modeText;
        }
    }

    function refreshWindArrows(doc) {
        (doc || (typeof document !== "undefined" ? document : null) || { querySelectorAll: function () { return []; } })
            .querySelectorAll("svg.weather-wind-arrow[data-blowto]").forEach(applyArrowRotation);
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
        refreshWindArrows();
        notifyCompass();
    }

    // Start (once) listening to the device compass so the arrow tracks the player's facing. iOS 13+ requires
    // this be triggered from a user gesture (we call it from the wind control click). Returns a Promise<boolean>.
    async function enableCompass() {
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
                        refreshWindArrows();
                        notifyCompass();
                    }
                }, 3000);
            }
            refreshWindArrows();
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
                    refreshWindArrows();
                    notifyCompass();
                    return false;
                } catch (_err) {
                    compassStatus = "denied";
                    refreshWindArrows();
                    notifyCompass();
                    return false;
                }
            }
            return attach();
        } catch (_e) {
            compassStatus = "unavailable";
            refreshWindArrows();
            notifyCompass();
            return false;
        }
    }

    function windArrow(doc, windFromDeg) {
        const model = windArrowModel(windFromDeg);
        if (!model) return null;
        const svg = doc.createElementNS(ARROW_NS, "svg");
        svg.setAttribute("class", "weather-wind-arrow");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "15");
        svg.setAttribute("height", "15");
        svg.setAttribute("data-blowto", String(model.blowTo));
        svg.setAttribute("role", "img");
        svg.style.transformOrigin = "center";
        svg.style.transition = "transform 0.25s ease-out";
        const title = doc.createElementNS(ARROW_NS, "title");
        svg.appendChild(title);
        svg.__titleEl = title;
        const path = doc.createElementNS(ARROW_NS, "path");
        path.setAttribute("d", "M12 2 L19 21 L12 16 L5 21 Z"); // an arrowhead-with-notch pointing up (blow-to)
        path.setAttribute("fill", "currentColor");
        svg.appendChild(path);
        applyArrowRotation(svg);
        return svg;
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

    function conditionGraphic(current) {
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

    function currentWeatherSummary(weather) {
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

    function formatLiveWeather(weather) {
        return weatherChips(weather).map((chip) => chip.label + ": " + chip.value).join(" - ");
    }

    function buildWeatherStrip(doc, weather, options) {
        const chips = weatherChips(weather);
        if (!chips.length) return null;
        const opts = options || {};
        const wrap = doc.createElement("div");
        wrap.className = "weather-strip";

        const head = doc.createElement("div");
        head.className = "weather-head";
        const title = doc.createElement("div");
        title.className = "weather-title";
        title.textContent = opts.title || "Round weather";
        head.appendChild(title);

        const current = weather && weather.current;
        const summary = currentWeatherSummary(weather);
        if (summary && summary.updatedText) {
            const updated = doc.createElement("div");
            updated.className = "weather-updated";
            updated.textContent = summary.updatedText;
            head.appendChild(updated);
        }
        wrap.appendChild(head);

        if (!summary) {
            const empty = doc.createElement("div");
            empty.className = "weather-empty";
            empty.textContent = chips.map((chip) => chip.value).join(" ");
            wrap.appendChild(empty);
        } else {
            const main = doc.createElement("div");
            main.className = "weather-main";

            const condition = doc.createElement("div");
            condition.className = "weather-condition";
            const temp = doc.createElement("div");
            temp.className = "weather-temp";
            temp.textContent = summary.tempText;
            const copy = doc.createElement("div");
            copy.className = "weather-copy";
            const name = doc.createElement("strong");
            name.textContent = summary.condition;
            copy.appendChild(name);
            if (summary.feelsText) {
                const feels = doc.createElement("span");
                feels.textContent = summary.feelsText;
                copy.appendChild(feels);
            }
            condition.appendChild(temp);
            condition.appendChild(copy);
            main.appendChild(condition);

            if (summary.graphic) {
                const graphic = doc.createElement("div");
                graphic.className = "weather-graphic";
                graphic.setAttribute("role", "img");
                graphic.setAttribute("aria-label", summary.graphic.label);
                const icon = doc.createElement("span");
                icon.className = "weather-graphic-icon";
                icon.setAttribute("aria-hidden", "true");
                icon.textContent = summary.graphic.icon;
                graphic.appendChild(icon);
                main.appendChild(graphic);
            }

            if (summary.windText) {
                const wind = doc.createElement("button");
                wind.className = "weather-wind";
                wind.type = "button";
                wind.title = "Tap to orient wind to your phone heading";
                wind.addEventListener("click", function () { enableCompass(); });
                const arrow = windArrow(doc, current.windDirectionDeg);
                if (arrow) {
                    arrow.__windControl = wind;
                    wind.appendChild(arrow);
                }
                const windCopy = doc.createElement("span");
                windCopy.className = "weather-wind-copy";
                const speed = doc.createElement("strong");
                speed.textContent = summary.windText;
                windCopy.appendChild(speed);
                if (summary.gustText) {
                    const gust = doc.createElement("span");
                    gust.textContent = summary.gustText;
                    windCopy.appendChild(gust);
                }
                const mode = doc.createElement("span");
                mode.className = "weather-wind-mode";
                mode.textContent = compassModeText();
                windCopy.appendChild(mode);
                wind.appendChild(windCopy);
                if (arrow) applyArrowRotation(arrow);
                main.appendChild(wind);
            }
            wrap.appendChild(main);

            const meta = [summary.humidityText, summary.precipText].filter(Boolean).concat(summary.changes);
            if (meta.length) {
                const metaRow = doc.createElement("div");
                metaRow.className = "weather-meta";
                meta.forEach(function (text) {
                    const item = doc.createElement("span");
                    item.textContent = text;
                    metaRow.appendChild(item);
                });
                wrap.appendChild(metaRow);
            }
        }

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
        compassState,
        conditionGraphic,
        conditionLabel,
        currentWeatherSummary,
        enableCompass,
        formatLiveWeather,
        renderWeather,
        subscribeCompass,
        weatherChanges,
        weatherChips,
        windArrowModel,
    };
})(typeof globalThis !== "undefined" ? globalThis : window);
