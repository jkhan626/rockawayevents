// netlify/functions/lib/ferry-core.js
// Shared NYC Ferry GTFS parsing core, used by:
//   - ferry.js          (public /api/ferry JSON feed)
//   - ferry-section.js  (scheduled writer of the Life OS "🚢 Ferry" section)
//
// Fetches the official static GTFS (a zip of CSVs), finds the Rockaway and
// Wall St/Pier 11 stops, and returns the one-seat departures for a date:
//   - AM: FROM Rockaway 7:00-11:00 (commute in)
//   - PM: FROM Wall St/Pier 11 13:00-18:00 (commute home)
//
// Schedule self-updates seasonally because it reads the live GTFS each call.
// Source: https://www.ferry.nyc/developer-tools/  (Connexionz static GTFS)

// Local zero-dependency stand-in for fflate's unzipSync (see lib/unzip.js).
// jamasha uses the fflate npm package here; this project ships no node_modules.
const { unzipSync } = require("./unzip");

const GTFS_URL = "https://nycferry.connexionz.net/rtt/public/utility/gtfs.aspx";
const AM_FROM = 7 * 3600, AM_TO = 11 * 3600;   // 7:00–11:00 from Rockaway
const PM_FROM = 13 * 3600, PM_TO = 18 * 3600;  // 1:00–6:00 from Wall St

// Minimal RFC-4180-ish CSV parser (handles quoted fields, doubled quotes, CRLF).
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== "")).map((r) => {
    const o = {};
    header.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : ""; });
    return o;
  });
}

const secsOf = (hms) => {
  if (!hms) return null;
  const m = hms.split(":");
  if (m.length < 2) return null;
  return (+m[0]) * 3600 + (+m[1]) * 60 + (+(m[2] || 0));
};
const pretty = (hms) => {
  const s = secsOf(hms);
  if (s == null) return hms;
  let h = Math.floor(s / 3600) % 24;
  const min = Math.floor((s % 3600) / 60);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(min).padStart(2, "0")} ${ap}`;
};

// ET "today" as YYYYMMDD + day-of-week (0 Sun..6 Sat)
function etDateInfo(override) {
  let ymd;
  if (override && /^\d{4}-?\d{2}-?\d{2}$/.test(override)) {
    ymd = override.replace(/-/g, "");
  } else {
    ymd = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replace(/-/g, "");
  }
  const y = +ymd.slice(0, 4), mo = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  const dow = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
  return { ymd, dow };
}
const DOW_COL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Returns the /api/ferry payload object for a date (YYYY-MM-DD or YYYYMMDD; default
// = today ET). Throws on GTFS fetch failure; returns { error } if stops not found.
async function getFerrySchedule(dateOverride) {
  const { ymd, dow } = etDateInfo(dateOverride);
  const weekdayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dow];

  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS fetch ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  const td = new TextDecoder("utf-8");
  const read = (name) => (files[name] ? parseCsv(td.decode(files[name])) : []);

  const stops = read("stops.txt");
  const trips = read("trips.txt");
  const stopTimes = read("stop_times.txt");
  const calendar = read("calendar.txt");
  const calDates = read("calendar_dates.txt");

  // Stop id sets for Rockaway and Wall St / Pier 11 (match by name, ignore case).
  // NYC Ferry's GTFS also lists their free *shuttle-bus* stops ("Rockaway Beach
  // Boulevard & Beach Xth St") — the ferry landing is the stop named exactly
  // "Rockaway", so prefer the exact match and fall back to substring only if absent.
  const rockSet = new Set(), wallSet = new Set();
  const rockNames = new Set(), wallNames = new Set();
  for (const s of stops) {
    const n = (s.stop_name || "").toLowerCase().trim();
    if (n === "rockaway") { rockSet.add(s.stop_id); rockNames.add(s.stop_name); }
    if (n.includes("wall st") || n.includes("pier 11")) { wallSet.add(s.stop_id); wallNames.add(s.stop_name); }
  }
  if (!rockSet.size) { // fallback: no exact "Rockaway" terminal, accept substring
    for (const s of stops) {
      if ((s.stop_name || "").toLowerCase().includes("rockaway")) { rockSet.add(s.stop_id); rockNames.add(s.stop_name); }
    }
  }
  if (!rockSet.size || !wallSet.size) {
    return { error: "could not locate Rockaway/Wall St stops in GTFS", stopsSampled: stops.slice(0, 40).map((s) => s.stop_name) };
  }

  // Services active on the target date: weekday column == 1 within date range,
  // honoring calendar_dates exceptions (1 = added, 2 = removed).
  const active = new Set();
  for (const c of calendar) {
    if (c[DOW_COL[dow]] === "1" && c.start_date <= ymd && ymd <= c.end_date) active.add(c.service_id);
  }
  for (const e of calDates) {
    if (e.date !== ymd) continue;
    if (e.exception_type === "1") active.add(e.service_id);
    if (e.exception_type === "2") active.delete(e.service_id);
  }

  // Trip -> service map (only active trips matter)
  const tripService = new Map();
  for (const t of trips) if (active.has(t.service_id)) tripService.set(t.trip_id, t);

  // Group active trips' stop_times by trip
  const byTrip = new Map();
  for (const st of stopTimes) {
    if (!tripService.has(st.trip_id)) continue;
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push(st);
  }

  const am = [], pm = [];
  for (const [tripId, sts] of byTrip) {
    sts.sort((a, b) => (+a.stop_sequence) - (+b.stop_sequence));
    let rock = null, wall = null;
    for (const st of sts) {
      if (rock == null && rockSet.has(st.stop_id)) rock = st;
      if (wall == null && wallSet.has(st.stop_id)) wall = st;
    }
    if (!rock || !wall) continue;
    const rockSeq = +rock.stop_sequence, wallSeq = +wall.stop_sequence;
    if (rockSeq < wallSeq) {
      // Rockaway -> Wall St (commute in)
      const dep = secsOf(rock.departure_time);
      if (dep != null && dep >= AM_FROM && dep <= AM_TO) {
        am.push({ dep: pretty(rock.departure_time), arr: pretty(wall.arrival_time), _s: dep });
      }
    } else if (wallSeq < rockSeq) {
      // Wall St -> Rockaway (commute home)
      const dep = secsOf(wall.departure_time);
      if (dep != null && dep >= PM_FROM && dep <= PM_TO) {
        pm.push({ dep: pretty(wall.departure_time), arr: pretty(rock.arrival_time), _s: dep });
      }
    }
  }
  am.sort((a, b) => a._s - b._s); pm.sort((a, b) => a._s - b._s);
  const strip = (a) => a.map(({ dep, arr }) => ({ dep, arr }));

  return {
    generated_at: new Date().toISOString(),
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    weekday: weekdayName,
    route: "Rockaway",
    stops: { rockaway: [...rockNames], wallst: [...wallNames] },
    am: { from: "Rockaway", to: "Wall St/Pier 11", window: "7:00–11:00 AM", departures: strip(am) },
    pm: { from: "Wall St/Pier 11", to: "Rockaway", window: "1:00–6:00 PM", departures: strip(pm) },
    source: "NYC Ferry static GTFS (ferry.nyc/developer-tools)",
  };
}

module.exports = { getFerrySchedule };
