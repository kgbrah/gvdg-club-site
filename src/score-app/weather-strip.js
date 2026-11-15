import React from "react";
import {
  compassState as currentCompassState,
  currentWeatherSummary,
  enableCompass,
  fetchCourseWeather,
  mergeFallbackWeather,
  subscribeCompass,
  weatherChips,
  windArrowModel,
} from "../shared/weather-model.js";

const h = React.createElement;

function useCompassState() {
  const [state, setState] = React.useState(() => currentCompassState());

  React.useEffect(() => {
    return subscribeCompass(setState);
  }, []);

  return state;
}

function WindArrow(props) {
  const model = props.model;
  if (!model) return null;
  return h(
    "svg",
    {
      "aria-label": model.label,
      className: "weather-wind-arrow",
      "data-blowto": String(model.blowTo),
      "data-compass-status": model.compassStatus,
      "data-relative": model.relative,
      height: 15,
      role: "img",
      style: {
        transform: `rotate(${model.rotationDeg}deg)`,
        transformOrigin: "center",
        transition: "transform 0.25s ease-out",
      },
      viewBox: "0 0 24 24",
      width: 15,
    },
    [
      h("title", { key: "title" }, model.label),
      h("path", { d: "M12 2 L19 21 L12 16 L5 21 Z", fill: "currentColor", key: "path" }),
    ],
  );
}

function WeatherGraphic(props) {
  if (!props.graphic) return null;
  return h("div", { "aria-label": props.graphic.label, className: "weather-graphic", role: "img" }, [
    h("span", { "aria-hidden": "true", className: "weather-graphic-icon", key: "icon" }, props.graphic.icon),
  ]);
}

function WeatherWind(props) {
  const summary = props.summary;
  if (!summary.windText) return null;
  const model = windArrowModel(props.windDirectionDeg);
  const modeText = model ? model.modeText : props.compassState.modeText;
  const windLabel = model ? model.label : "Tap to orient wind to your phone heading";
  const windReadout = props.scorecard ? ["Wind " + summary.windText, props.gustText, windLabel].filter(Boolean).join(". ") : windLabel;

  return h(
    "button",
    {
      "aria-label": windReadout,
      className: props.compact ? "weather-wind weather-wind-compact" : "weather-wind",
      "data-compass-status": model ? model.compassStatus : props.compassState.status,
      "data-relative": model ? model.relative : props.compassState.relative,
      title: "Tap to orient wind to your phone heading",
      type: "button",
      onClick: () => {
        void enableCompass();
      },
    },
    [
      h(WindArrow, { key: "arrow", model }),
      h("span", { className: "weather-wind-copy", key: "copy" }, [
        h("strong", { key: "speed" }, (props.scorecard ? "Wind " : "") + summary.windText),
        props.scorecard && props.gustText ? h("span", { key: "course-gust" }, props.gustText) : null,
        props.compact ? null : (summary.gustText ? h("span", { key: "gust" }, summary.gustText) : null),
        props.compact ? null : h("span", { className: "weather-wind-mode", key: "mode" }, modeText),
      ]),
    ],
  );
}

function useResolvedWeather(serverWeather) {
  const hasCurrent = Boolean(serverWeather && serverWeather.current);
  const loc = serverWeather && serverWeather.location;
  const lat = loc ? loc.lat : null;
  const lng = loc ? loc.lng : null;
  const canFallback = Boolean(!hasCurrent && lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)));
  const [fallback, setFallback] = React.useState(null);
  const [pending, setPending] = React.useState(canFallback);

  React.useEffect(() => {
    if (!canFallback) {
      setFallback(null);
      setPending(false);
      return undefined;
    }
    let cancelled = false;
    setPending(true);
    fetchCourseWeather(loc).then((sample) => {
      if (cancelled) return;
      setPending(false);
      setFallback(sample ? mergeFallbackWeather(serverWeather, sample) : null);
    });
    return function () {
      cancelled = true;
    };
  }, [hasCurrent, lat, lng, serverWeather && serverWeather.error]);

  if (hasCurrent) return serverWeather;
  if (fallback && fallback.current) return fallback;
  if (pending && serverWeather) return { ...serverWeather, error: null };
  return serverWeather;
}

export function WeatherStrip(props) {
  const compassState = useCompassState();
  const weather = useResolvedWeather(props.weather);

  const chips = weatherChips(weather);
  if (!chips.length && !props.scorecard) return null;

  const summary = currentWeatherSummary(weather);
  const current = weather && weather.current;
  const meta = summary ? [summary.humidityText, summary.precipText].filter(Boolean).concat(summary.changes) : [];
  const wind = summary
    ? h(WeatherWind, {
      compact: Boolean(props.compact),
      compassState,
      key: "wind",
      summary,
      windDirectionDeg: current && current.windDirectionDeg,
    })
    : null;

  if (props.scorecard) {
    const gust = current?.windGustMph;
    const pending = weather && !weather.current && !weather.error;
    return h("section", { className: "score-concept-weather", "aria-label": "Round weather" },
      summary ? h("div", { className: "score-concept-conditions", title: summary.updatedText || undefined },
        h(WeatherGraphic, { graphic: summary.graphic }),
        h("div", null, h("strong", null, summary.tempText === "--" ? summary.condition : summary.tempText),
          summary.tempText !== "--" && h("span", null, summary.condition)))
        : h("div", { className: "score-concept-weather-status", role: "status" }, pending ? "Checking weather…" : "Weather unavailable"),
      summary?.windText ? h(WeatherWind, {
        compact: true, scorecard: true, compassState, summary, windDirectionDeg: current.windDirectionDeg,
        gustText: typeof gust === "number" && Number.isFinite(gust) ? "Gusts " + Math.round(gust) + " mph" : null,
      }) : h("div", { className: "score-concept-weather-status" }, pending ? "Wind pending" : "Wind unavailable"),
    );
  }

  if (props.compact) {
    return h("div", { className: "weather-strip weather-strip-compact", title: props.title || "Round weather" }, [
      summary ? h("div", { className: "weather-temp", key: "temp" }, summary.tempText) : null,
      summary
        ? h("div", { className: "weather-compact-copy", key: "copy" }, summary.condition)
        : h("div", { className: "weather-empty", key: "empty" }, chips.map((chip) => chip.value).join(" ")),
      h(WeatherGraphic, { graphic: summary && summary.graphic, key: "graphic" }),
      wind,
    ]);
  }

  return h("div", { className: "weather-strip" }, [
    h("div", { className: "weather-head", key: "head" }, [
      h("div", { className: "weather-title", key: "title" }, props.title || "Round weather"),
      summary && summary.updatedText ? h("div", { className: "weather-updated", key: "updated" }, summary.updatedText) : null,
    ]),
    summary
      ? h("div", { className: "weather-main", key: "main" }, [
          h("div", { className: "weather-condition", key: "condition" }, [
            h("div", { className: "weather-temp", key: "temp" }, summary.tempText),
            h("div", { className: "weather-copy", key: "copy" }, [
              h("strong", { key: "condition" }, summary.condition),
              summary.feelsText ? h("span", { key: "feels" }, summary.feelsText) : null,
            ]),
          ]),
          h(WeatherGraphic, { graphic: summary.graphic, key: "graphic" }),
          wind,
        ])
      : h("div", { className: "weather-empty", key: "empty" }, chips.map((chip) => chip.value).join(" ")),
    meta.length
      ? h("div", { className: "weather-meta", key: "meta" }, meta.map((text) => h("span", { key: text }, text)))
      : null,
    weather && weather.location && weather.location.label
      ? h("div", { className: "weather-note", key: "note" }, weather.location.label)
      : null,
  ]);
}
