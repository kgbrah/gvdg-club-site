import { describe, expect, it } from "vitest";
import {
  createWeatherState,
  fetchCurrentWeather,
  parseNwsObservation,
  parseOpenMeteoCurrent,
  ratingWeatherFromJson,
  refreshWeatherState,
  weatherLocationForCourse,
} from "../src/weather.js";

describe("live round weather", () => {
  it("parses current rain and wind conditions from Open-Meteo", () => {
    const parsed = parseOpenMeteoCurrent({
      current: {
        time: "2026-07-01T08:00",
        temperature_2m: 84.24,
        apparent_temperature: 91.11,
        relative_humidity_2m: 79,
        precipitation: 0.03,
        rain: 0.02,
        showers: 0.01,
        snowfall: 0,
        weather_code: 61,
        cloud_cover: 88,
        wind_speed_10m: 12.34,
        wind_direction_10m: 203,
        wind_gusts_10m: 21.98,
        is_day: 1,
      },
    }, "2026-07-01T12:00:00.000Z");

    expect(parsed).toMatchObject({
      observedAt: "2026-07-01T08:00",
      fetchedAt: "2026-07-01T12:00:00.000Z",
      temperatureF: 84.2,
      apparentTemperatureF: 91.1,
      precipitationIn: 0.03,
      rainIn: 0.02,
      windSpeedMph: 12.3,
      windGustMph: 22,
      weatherCode: 61,
      isDay: true,
    });
  });

  it("parses NWS station observations into round weather", () => {
    const parsed = parseNwsObservation({
      properties: {
        timestamp: "2026-09-21T12:15:00+00:00",
        textDescription: "Clear",
        temperature: { value: 24 },
        heatIndex: { value: 24.8 },
        relativeHumidity: { value: 88.6 },
        windDirection: { value: 240 },
        windSpeed: { value: 16.1 },
        windGust: { value: 32.2 },
        precipitationLastHour: { value: 0 },
      },
    }, "2026-09-21T12:16:00.000Z");

    expect(parsed).toMatchObject({
      source: "nws",
      observedAt: "2026-09-21T12:15:00+00:00",
      temperatureF: 75.2,
      apparentTemperatureF: 76.6,
      relativeHumidity: 88.6,
      windSpeedMph: 10,
      windGustMph: 20,
      weatherCode: 0,
      rainIn: 0,
    });
  });

  it("resolves weather coordinates from course GPS or layout hole GPS", () => {
    expect(weatherLocationForCourse(
      { name: "North Rec", location: "Greenville, NC", lat: 35.631092, lng: -77.319923 },
      { holes: "[]" },
    )).toEqual({ lat: 35.631092, lng: -77.319923, label: "North Rec - Greenville, NC" });

    expect(weatherLocationForCourse(
      { name: "Imported Layout" },
      { holes: JSON.stringify([{ tee: { lat: 35, lng: -77 }, target: { lat: 36, lng: -78 } }]) },
    )).toEqual({ lat: 35.5, lng: -77.5, label: "Imported Layout" });
  });

  it("extracts the peak recorded gust from stored round weather", () => {
    expect(ratingWeatherFromJson(null)).toEqual({ windGustMph: null });
    expect(ratingWeatherFromJson(JSON.stringify({
      current: { windGustMph: 18.4 },
      history: [{ windGustMph: 19.1 }, { wind_gusts_10m: 25.24 }],
    }))).toEqual({ windGustMph: 25.2 });
  });

  it("falls back to NWS when Open-Meteo is rate limited", async () => {
    const doFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("open-meteo")) {
        return new Response(JSON.stringify({ error: true, reason: "Daily API request limit exceeded." }), { status: 429 });
      }
      if (url.includes("api.weather.gov/points/")) {
        return new Response(JSON.stringify({
          properties: { observationStations: "https://api.weather.gov/gridpoints/MHX/30,95/stations" },
        }));
      }
      if (url.includes("/stations") && !url.includes("/observations")) {
        return new Response(JSON.stringify({
          features: [{ properties: { stationIdentifier: "KPGV" } }],
        }));
      }
      if (url.includes("/observations/latest")) {
        return new Response(JSON.stringify({
          properties: {
            timestamp: "2026-09-21T12:15:00+00:00",
            textDescription: "Clear",
            temperature: { value: 24 },
            heatIndex: { value: 24.8 },
            relativeHumidity: { value: 88.6 },
            windDirection: { value: 240 },
            windSpeed: { value: 16.1 },
            windGust: { value: 32.2 },
            precipitationLastHour: { value: 0 },
          },
        }));
      }
      return new Response("missing", { status: 404 });
    };

    const location = { lat: 35.6264, lng: -77.375, label: "West Meadowbrook Park - Greenville, NC" };
    const sample = await fetchCurrentWeather(location, doFetch, "2026-09-21T12:16:00.000Z");
    expect(sample?.source).toBe("nws");
    expect(sample?.temperatureF).toBe(75.2);

    const started = createWeatherState(location, Date.parse("2026-09-21T12:00:00.000Z"));
    expect(started).not.toBeNull();
    const next = await refreshWeatherState(started!, doFetch, Date.parse("2026-09-21T12:00:00.000Z"));
    expect(next.error).toBeNull();
    expect(next.current?.source).toBe("nws");
    expect(next.current?.windSpeedMph).toBe(10);
  });
});
