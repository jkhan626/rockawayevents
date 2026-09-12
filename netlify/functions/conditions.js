// netlify/functions/conditions.js  ->  GET /api/conditions
// Beach conditions for Rockaway Beach, Queens. Every upstream is free and
// keyless, and every one is fetched in its own try/catch with a 6 second
// timeout, so a single outage degrades the strip instead of blanking it.
//
// Upstreams:
//   Open-Meteo forecast  air temp, wind, UV, skies, 6 day outlook, sun times
//   Open-Meteo marine    wave height / period / direction, sea surface temp
//   NDBC buoy 44065      measured water temp (and wave fallback) 15 mi offshore
//   NOAA CO-OPS          tide predictions
//
// Tide station: 8517137 "Beach Channel (bridge)", 40.5883 / -73.8200.
// Chosen by querying the CO-OPS metadata API for every type=tidepredictions
// station and sorting by great-circle distance from 40.58 / -73.82: this one is
// 0.57 mi away, the next candidate (Barren Island, Rockaway Inlet 8517394) is
// 3.59 mi and JFK 8516999 is 3.56 mi. It is the Jamaica Bay side of the
// peninsula rather than the ocean face, but no CO-OPS prediction station exists
// on the ocean side of Rockaway, and it is the closest tidal signal available.

const LAT = 40.5834;
const LON = -73.8155;
const MARINE_LAT = 40.57;
const MARINE_LON = -73.82;
const TIDE_STATION = "8517137";
const NDBC_BUOY = "44065";
const TIMEOUT_MS = 6000;

const FORECAST_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=" +
  LAT +
  "&longitude=" +
  LON +
  "&current=temperature_2m,apparent_temperature,precipitation,weather_code," +
  "wind_speed_10m,wind_direction_10m,uv_index" +
  "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max," +
  "weather_code,sunrise,sunset,uv_index_max" +
  "&hourly=precipitation_probability" +
  "&temperature_unit=fahrenheit&wind_speed_unit=mph" +
  "&timezone=America/New_York&forecast_days=6";

// length_unit=imperial gives wave_height in feet; sea_surface_temperature
// stays in Celsius regardless, so it is converted below.
const MARINE_URL =
  "https://marine-api.open-meteo.com/v1/marine?latitude=" +
  MARINE_LAT +
  "&longitude=" +
  MARINE_LON +
  "&current=wave_height,wave_period,wave_direction,sea_surface_temperature" +
  "&length_unit=imperial&timezone=America/New_York";

const NDBC_URL = "https://www.ndbc.noaa.gov/data/realtime2/" + NDBC_BUOY + ".txt";

/* ---- small helpers ----------------------------------------------------- */

const cToF = (c) => (c * 9) / 5 + 32;
const mToFt = (m) => m * 3.28084;
const r1 = (n) => (typeof n === "number" && isFinite(n) ? Math.round(n * 10) / 10 : null);
const r0 = (n) => (typeof n === "number" && isFinite(n) ? Math.round(n) : null);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// WMO weather codes to short plain text.
const WEATHER_CODES = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Cloudy",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorms",
  96: "Thunderstorms with hail",
  99: "Thunderstorms with hail",
};
const skiesOf = (code) =>
  WEATHER_CODES[code] !== undefined ? WEATHER_CODES[code] : "Unsettled";
const isStormy = (code) => code >= 95;
const isWet = (code) => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function compass(deg) {
  if (typeof deg !== "number" || !isFinite(deg)) return null;
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// 12 hour label from a "HH:MM" or "...THH:MM" string.
function clockLabel(s) {
  const m = String(s || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + m[2] + " " + ap;
}

// Current America/New_York wall clock as { ymd, hhmm, iso } plus the live UTC
// offset ("-04:00" in EDT). Used to filter tides and pick the current hour.
function nowET() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  const ymd = g("year") + "-" + g("month") + "-" + g("day");
  const hhmm = (g("hour") === "24" ? "00" : g("hour")) + ":" + g("minute");
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  const raw = (tzName && tzName.value) || "GMT-05:00";
  const offset = raw.replace("GMT", "") || "-05:00";
  return { ymd, hhmm, offset };
}

// Fetch with a hard timeout. Never throws an unhandled rejection: the caller
// wraps it, and a failure here only costs that one section of the payload.
async function get(url, { json = true, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: Object.assign(
        // api.weather.gov and NDBC both want a real User-Agent.
        { "User-Agent": "rockawayevents.org (hello@rockawayevents.org)" },
        headers
      ),
    });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    return json ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---- upstream parsers -------------------------------------------------- */

function parseForecast(d, et) {
  const cur = d.current || {};
  const daily = d.daily || {};
  const hourly = d.hourly || {};

  // Precip chance right now: the hourly row for the current ET hour.
  let precipChance = null;
  if (Array.isArray(hourly.time) && Array.isArray(hourly.precipitation_probability)) {
    const key = et.ymd + "T" + et.hhmm.slice(0, 2) + ":00";
    const i = hourly.time.indexOf(key);
    if (i >= 0) precipChance = hourly.precipitation_probability[i];
  }
  if (precipChance == null && Array.isArray(daily.precipitation_probability_max)) {
    precipChance = daily.precipitation_probability_max[0];
  }

  const forecast = [];
  const days = Array.isArray(daily.time) ? daily.time.length : 0;
  for (let i = 0; i < Math.min(5, days); i++) {
    const ymd = daily.time[i];
    const [y, m, dd] = ymd.split("-").map(Number);
    forecast.push({
      date: ymd,
      day: DOWS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()],
      hi: r0(daily.temperature_2m_max[i]),
      lo: r0(daily.temperature_2m_min[i]),
      precip: r0(daily.precipitation_probability_max[i]),
      short: skiesOf(daily.weather_code[i]),
      uvMax: r1(daily.uv_index_max ? daily.uv_index_max[i] : null),
    });
  }

  // Open-Meteo returns a bare local stamp ("2026-09-12T06:33"), which
  // new Date() would read in the VIEWER's timezone. Stamp the live ET offset so
  // the instant is unambiguous everywhere.
  const stampET = (s) => {
    const m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? m[1] + "T" + m[2] + ":00" + et.offset : null;
  };
  const rise = stampET(daily.sunrise ? daily.sunrise[0] : null);
  const set = stampET(daily.sunset ? daily.sunset[0] : null);

  return {
    now: {
      tempF: r0(cur.temperature_2m),
      feelsF: r0(cur.apparent_temperature),
      windMph: r0(cur.wind_speed_10m),
      windDir: compass(cur.wind_direction_10m),
      windDeg: r0(cur.wind_direction_10m),
      uv: r1(cur.uv_index),
      skies: skiesOf(cur.weather_code),
      precipChance: r0(precipChance),
      precipNow: r1(cur.precipitation),
      code: r0(cur.weather_code),
    },
    sun: {
      rise,
      set,
      riseLabel: clockLabel(rise),
      setLabel: clockLabel(set),
    },
    forecast,
  };
}

function parseMarine(d) {
  const c = d.current || {};
  const sst = typeof c.sea_surface_temperature === "number"
    ? c.sea_surface_temperature
    : null;
  return {
    waveFt: r1(c.wave_height),
    wavePeriodS: r1(c.wave_period),
    waveDir: compass(c.wave_direction),
    waveDeg: r0(c.wave_direction),
    // The marine API reports SST in Celsius even with length_unit=imperial.
    modelTempF: sst == null ? null : r0(cToF(sst)),
  };
}

// NDBC realtime2 is a fixed-column text table, newest row first, with "MM" for
// missing values. Walk down until each field has a real number.
function parseNdbc(text) {
  const lines = String(text).split("\n").filter((l) => l && !l.startsWith("#"));
  const out = { tempF: null, waveFt: null, wavePeriodS: null, waveDeg: null, observed: null };
  const num = (v) => {
    if (v === undefined || v === "MM") return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };
  for (const line of lines.slice(0, 40)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 15) continue;
    // YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP ...
    const wtmp = num(f[14]);
    const wvht = num(f[8]);
    const dpd = num(f[9]);
    const mwd = num(f[11]);
    if (out.tempF == null && wtmp != null) {
      out.tempF = r0(cToF(wtmp));
      out.observed = f[0] + "-" + f[1] + "-" + f[2] + "T" + f[3] + ":" + f[4] + "Z";
    }
    if (out.waveFt == null && wvht != null) out.waveFt = r1(mToFt(wvht));
    if (out.wavePeriodS == null && dpd != null) out.wavePeriodS = r1(dpd);
    if (out.waveDeg == null && mwd != null) out.waveDeg = r0(mwd);
    if (out.tempF != null && out.waveFt != null && out.wavePeriodS != null) break;
  }
  return out;
}

// Next 4 high/low predictions, dropping anything already past in ET.
function parseTides(d, et) {
  const rows = Array.isArray(d.predictions) ? d.predictions : [];
  const nowKey = et.ymd + " " + et.hhmm;
  const out = [];
  for (const p of rows) {
    if (!p || !p.t) continue;
    if (p.t < nowKey) continue;
    const h = Number(p.v);
    out.push({
      type: p.type === "H" ? "H" : "L",
      // NOAA returned local standard/daylight time; stamp the live ET offset.
      time: p.t.replace(" ", "T") + ":00" + et.offset,
      timeLabel: clockLabel(p.t.slice(11)),
      heightFt: isFinite(h) ? Math.round(h * 10) / 10 : null,
    });
    if (out.length >= 4) break;
  }
  return out;
}

/* ---- lifeguards -------------------------------------------------------- */

// NYC ocean beaches: lifeguards from the Saturday of Memorial Day weekend
// (the Saturday before the last Monday in May) through the second Sunday of
// September. That end date is the conservative reading of "Labor Day weekend
// plus the following week": in most years it lands on or just after the Sunday
// after Labor Day without ever over-claiming a staffed beach.
function lifeguardSeason(year) {
  // Last Monday in May.
  const may31 = new Date(Date.UTC(year, 4, 31));
  const backToMonday = (may31.getUTCDay() + 6) % 7;
  const memorialDay = new Date(Date.UTC(year, 4, 31 - backToMonday));
  const start = new Date(memorialDay);
  start.setUTCDate(start.getUTCDate() - 2); // the Saturday before

  // Second Sunday of September.
  const sep1 = new Date(Date.UTC(year, 8, 1));
  const firstSunday = 1 + ((7 - sep1.getUTCDay()) % 7);
  const end = new Date(Date.UTC(year, 8, firstSunday + 7));

  const label = (d) => MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    text: label(start) + " to " + label(end) + ", " + year,
  };
}

function lifeguards(et) {
  const year = Number(et.ymd.slice(0, 4));
  const s = lifeguardSeason(year);
  const inSeason = et.ymd >= s.start && et.ymd <= s.end;
  const hour = Number(et.hhmm.slice(0, 2));
  const onDuty = inSeason && hour >= 10 && hour < 18;
  return {
    onDuty,
    inSeason,
    season: s.text,
    seasonStart: s.start,
    seasonEnd: s.end,
    hours: "10 AM to 6 PM",
    note: "Swimming is only allowed when lifeguards are on duty (10 AM to 6 PM).",
  };
}

/* ---- beach score ------------------------------------------------------- */

// 0 to 10, starting at 10 and deducting for each thing working against a beach
// day. Reasons are short plain sentences, no emojis and no em dashes.
function beachScore(now, water, guards) {
  let score = 10;
  const reasons = [];

  const temp = now.tempF;
  if (typeof temp === "number") {
    if (temp < 70) {
      const hit = Math.min(5, (70 - temp) * 0.35);
      score -= hit;
      reasons.push("Air is only " + temp + " degrees.");
    } else if (temp >= 85) {
      reasons.push("Hot at " + temp + " degrees, bring water and shade.");
    } else {
      reasons.push("Air is " + temp + " degrees.");
    }
  }

  if (typeof now.code === "number" && isStormy(now.code)) {
    score -= 4;
    reasons.push("Thunderstorms in the area.");
  } else if (typeof now.precipNow === "number" && now.precipNow > 0) {
    score -= 3;
    reasons.push("It is raining right now.");
  } else if (typeof now.precipChance === "number" && now.precipChance > 30) {
    score -= Math.min(4, (now.precipChance - 30) / 10);
    reasons.push(now.precipChance + " percent chance of rain.");
  } else if (typeof now.code === "number" && !isWet(now.code)) {
    reasons.push("Skies are " + String(now.skies).toLowerCase() + ".");
  }

  if (typeof now.windMph === "number") {
    if (now.windMph > 15) {
      score -= Math.min(3, (now.windMph - 15) * 0.25);
      reasons.push(
        "Windy at " + now.windMph + " mph" + (now.windDir ? " from the " + now.windDir : "") + "."
      );
    } else {
      reasons.push("Wind is light at " + now.windMph + " mph.");
    }
  }

  if (typeof water.waveFt === "number") {
    if (water.waveFt > 4) {
      score -= Math.min(2, (water.waveFt - 4) * 0.6);
      reasons.push("Surf is up at " + water.waveFt + " ft, rough for swimming.");
    } else if (water.waveFt >= 2) {
      reasons.push("Waves around " + water.waveFt + " ft.");
    }
  }

  if (typeof water.tempF === "number") {
    if (water.tempF < 65) {
      score -= Math.min(2, (65 - water.tempF) * 0.2);
      reasons.push("Water is cold at " + water.tempF + " degrees.");
    } else {
      reasons.push("Water is " + water.tempF + " degrees.");
    }
  }

  // UV is a note, not a penalty: strong sun does not make it a bad beach day.
  if (typeof now.uv === "number" && now.uv >= 8) {
    reasons.push("UV index is " + now.uv + ", very high. Reapply sunscreen.");
  } else if (typeof now.uv === "number" && now.uv >= 6) {
    reasons.push("UV index is " + now.uv + ". Wear sunscreen.");
  }

  if (guards && !guards.inSeason) {
    reasons.push("Lifeguards are off for the season, so swimming is not allowed.");
  } else if (guards && !guards.onDuty) {
    reasons.push("No lifeguards on duty right now. They work 10 AM to 6 PM.");
  }

  score = Math.max(0, Math.min(10, Math.round(score)));
  const label = score >= 8 ? "Great beach day" : score >= 5 ? "Decent" : "Not today";
  return { score, label, reasons };
}

/* ---- handler ----------------------------------------------------------- */

async function build() {
  const et = nowET();
  const errors = [];

  const settle = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      errors.push(name + ": " + String((err && err.message) || err));
      return null;
    }
  };

  const tideBegin = et.ymd.replace(/-/g, "");
  const TIDE_URL =
    "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions" +
    "&datum=MLLW&station=" + TIDE_STATION +
    "&time_zone=lst_ldt&units=english&interval=hilo&format=json" +
    "&begin_date=" + tideBegin + "&range=48";

  const [fc, marine, buoy, tideRaw] = await Promise.all([
    settle("forecast", async () => parseForecast(await get(FORECAST_URL), et)),
    settle("marine", async () => parseMarine(await get(MARINE_URL))),
    settle("buoy", async () => parseNdbc(await get(NDBC_URL, { json: false }))),
    settle("tides", async () => await get(TIDE_URL)),
  ]);

  const now = (fc && fc.now) || {
    tempF: null, feelsF: null, windMph: null, windDir: null,
    uv: null, skies: null, precipChance: null, precipNow: null, code: null,
  };
  const sun = (fc && fc.sun) || { rise: null, set: null, riseLabel: null, setLabel: null };
  const forecast = (fc && fc.forecast) || [];

  // Water: the buoy is a real measurement, so it wins; the marine model is the
  // fallback. Both are reported when they disagree by more than 4 degrees.
  const buoyTemp = buoy && buoy.tempF;
  const modelTemp = marine && marine.modelTempF;
  const water = {
    tempF: buoyTemp != null ? buoyTemp : modelTemp != null ? modelTemp : null,
    waveFt: marine && marine.waveFt != null ? marine.waveFt : buoy ? buoy.waveFt : null,
    wavePeriodS:
      marine && marine.wavePeriodS != null ? marine.wavePeriodS : buoy ? buoy.wavePeriodS : null,
    waveDir:
      marine && marine.waveDir
        ? marine.waveDir
        : buoy && buoy.waveDeg != null
          ? compass(buoy.waveDeg)
          : null,
    source: buoyTemp != null ? "NDBC buoy " + NDBC_BUOY : modelTemp != null ? "Open-Meteo marine model" : null,
  };
  if (buoyTemp != null && modelTemp != null && Math.abs(buoyTemp - modelTemp) > 4) {
    water.modelTempF = modelTemp;
  }

  const tides = tideRaw ? parseTides(tideRaw, et) : [];
  const guards = lifeguards(et);

  const payload = {
    updated: new Date().toISOString(),
    today: et.ymd,
    now,
    water,
    tides,
    sun,
    forecast,
    beachScore: beachScore(now, water, guards),
    lifeguards: guards,
    station: { tides: TIDE_STATION, buoy: NDBC_BUOY, lat: LAT, lon: LON },
  };
  if (errors.length) payload.errors = errors;
  return payload;
}

exports.handler = async () => {
  try {
    const payload = await build();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=900",
        "Netlify-CDN-Cache-Control":
          "public, max-age=900, stale-while-revalidate=3600",
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    // Only reachable if the assembly itself throws; every upstream is already
    // individually guarded above.
    console.error("conditions: " + String((err && err.stack) || err));
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Conditions unavailable", detail: String(err) }),
    };
  }
};

// exported for tests
exports.beachScore = beachScore;
exports.lifeguardSeason = lifeguardSeason;
exports.parseNdbc = parseNdbc;
exports.parseTides = parseTides;
exports.nowET = nowET;
exports.skiesOf = skiesOf;
exports.compass = compass;
