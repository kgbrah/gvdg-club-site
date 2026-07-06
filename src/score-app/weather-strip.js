import React from "react";

const h = React.createElement;

function weatherApi() {
  return typeof window === "undefined" ? null : window.GVDGWeather || null;
}

function fallbackCompassState() {
  return { heading: null, modeText: "North-up", relative: "north", status: "off" };
}

function useCompassState(weather) {
  const [state, setState] = React.useState(() => {
    const api = weatherApi();
    return api && typeof api.compassState === "function" ? api.compassState() : fallbackCompassState();
  });

  React.useEffect(() => {
    const api = weatherApi();
    if (!api || typeof api.subscribeCompass !== "function") return undefined;
    return api.subscribeCompass(setState);
  }, []);

  React.useEffect(() => {
    const api = weatherApi();
    if (weather && weather.current && api && typeof api.enableCompass === "function") api.enableCompass();
  }, [weather]);

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
  const api = weatherApi();
  const model = api && typeof api.windArrowModel === "function" ? api.windArrowModel(props.windDirectionDeg) : null;
  const modeText = model ? model.modeText : props.compassState.modeText;
  const windLabel = model ? model.label : "Tap to orient wind to your phone heading";

  return h(
    "button",
    {
      "aria-label": windLabel,
      className: "weather-wind",
      "data-compass-status": model ? model.compassStatus : props.compassState.status,
      "data-relative": model ? model.relative : props.compassState.relative,
      title: "Tap to orient wind to your phone heading",
      type: "button",
      onClick: () => {
        const nextApi = weatherApi();
        if (nextApi && typeof nextApi.enableCompass === "function") nextApi.enableCompass();
      },
    },
    [
      h(WindArrow, { key: "arrow", model }),
      h("span", { className: "weather-wind-copy", key: "copy" }, [
        h("strong", { key: "speed" }, summary.windText),
        summary.gustText ? h("span", { key: "gust" }, summary.gustText) : null,
        h("span", { className: "weather-wind-mode", key: "mode" }, modeText),
      ]),
    ],
  );
}

export function WeatherStrip(props) {
  const api = weatherApi();
  const compassState = useCompassState(props.weather);
  if (!api || typeof api.weatherChips !== "function") return null;

  const chips = api.weatherChips(props.weather);
  if (!chips.length) return null;

  const summary = typeof api.currentWeatherSummary === "function" ? api.currentWeatherSummary(props.weather) : null;
  const current = props.weather && props.weather.current;
  const meta = summary ? [summary.humidityText, summary.precipText].filter(Boolean).concat(summary.changes) : [];

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
          h(WeatherWind, {
            compassState,
            key: "wind",
            summary,
            windDirectionDeg: current && current.windDirectionDeg,
          }),
        ])
      : h("div", { className: "weather-empty", key: "empty" }, chips.map((chip) => chip.value).join(" ")),
    meta.length
      ? h("div", { className: "weather-meta", key: "meta" }, meta.map((text) => h("span", { key: text }, text)))
      : null,
    props.weather && props.weather.location && props.weather.location.label
      ? h("div", { className: "weather-note", key: "note" }, props.weather.location.label)
      : null,
  ]);
}
