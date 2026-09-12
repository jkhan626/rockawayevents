// netlify/functions/calendar-ics.js  ->  GET /api/calendar.ics
// Subscribable iCalendar feed of the same list /api/events serves, so people
// can add "Rockaway Events" to Google or Apple Calendar with a webcal:// link.

const { getEvents, DEFAULT_DURATION_MIN } = require("./lib/events-core");

const TZID = "America/New_York";
const DOMAIN = "rockawayevents.org";

// A self-contained VTIMEZONE so clients that do not know the Olson database
// still place timed events correctly (US DST rules since 2007).
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:20070311T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:20071104T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/* ---- RFC 5545 text handling -------------------------------------------- */

// Escape a TEXT value: backslash first, then the structural characters.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Fold a content line to 75 OCTETS (not characters) per line, continuation
// lines starting with a single space. Folding is done on the UTF-8 byte string
// but never inside a multi-byte character.
function fold(line) {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75; // first line gets 75; continuations get 74 plus the leading space
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    // Back off if we landed inside a UTF-8 continuation byte (10xxxxxx).
    while (end > start + 1 && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    parts.push(buf.slice(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

const ymdCompact = (ymd) => String(ymd).slice(0, 10).replace(/-/g, "");

// Shift a YYYY-MM-DD by n days (UTC math, DST-proof).
function addDays(ymd, n) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Add minutes to a local wall-clock date + "HH:MM", returning both halves.
// Pure wall-clock arithmetic: with TZID the client resolves the real instant.
function addMinutesLocal(ymd, hhmm, minutes) {
  const [h, mi] = hhmm.split(":").map(Number);
  const total = h * 60 + mi + minutes;
  const dayShift = Math.floor(total / 1440);
  const rem = ((total % 1440) + 1440) % 1440;
  return {
    date: dayShift ? addDays(ymd, dayShift) : ymd,
    time:
      String(Math.floor(rem / 60)).padStart(2, "0") +
      ":" +
      String(rem % 60).padStart(2, "0"),
  };
}

const localStamp = (ymd, hhmm) =>
  ymdCompact(ymd) + "T" + hhmm.replace(":", "") + "00";

const utcStamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/* ---- VEVENT ------------------------------------------------------------ */

function vevent(e, dtstamp) {
  const lines = [];
  lines.push("BEGIN:VEVENT");
  lines.push("UID:" + e.id + "@" + DOMAIN);
  lines.push("DTSTAMP:" + dtstamp);

  if (e.timeStart) {
    // Timed: local wall clock plus TZID, default 2 hours long.
    const end = addMinutesLocal(e.date, e.timeStart, DEFAULT_DURATION_MIN);
    lines.push("DTSTART;TZID=" + TZID + ":" + localStamp(e.date, e.timeStart));
    lines.push("DTEND;TZID=" + TZID + ":" + localStamp(end.date, end.time));
  } else {
    // All-day: DTEND is exclusive, so it is the day AFTER the last day.
    const last = e.dateEnd && e.dateEnd > e.date ? e.dateEnd : e.date;
    lines.push("DTSTART;VALUE=DATE:" + ymdCompact(e.date));
    lines.push("DTEND;VALUE=DATE:" + ymdCompact(addDays(last, 1)));
  }

  lines.push("SUMMARY:" + esc(e.event));

  const location = [e.venue, e.address].filter(Boolean).join(", ");
  if (location) lines.push("LOCATION:" + esc(location));

  const descParts = [];
  if (e.description) descParts.push(e.description);
  if (e.time) descParts.push("Time: " + e.time);
  if (!e.free && e.cost) descParts.push("Cost: " + e.cost);
  if (e.free) descParts.push("Free");
  if (e.url) descParts.push(e.url);
  if (descParts.length) lines.push("DESCRIPTION:" + esc(descParts.join("\n\n")));

  if (e.url) lines.push("URL:" + esc(e.url));
  if (Array.isArray(e.category) && e.category.length) {
    lines.push("CATEGORIES:" + e.category.map(esc).join(","));
  }

  lines.push("END:VEVENT");
  return lines;
}

function buildIcs(payload) {
  const dtstamp = utcStamp(new Date(payload.updated || Date.now()));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//rockawayevents.org//Rockaway Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Rockaway Events",
    "X-WR-CALDESC:Everything happening on the Rockaway peninsula",
    "X-WR-TIMEZONE:America/New_York",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    ...VTIMEZONE,
  ];
  for (const e of payload.events || []) {
    if (!e.date) continue;
    lines.push(...vevent(e, dtstamp));
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

exports.handler = async () => {
  try {
    const payload = await getEvents();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="rockaway-events.ics"',
        "Cache-Control": "public, max-age=3600",
        "Netlify-CDN-Cache-Control":
          "public, max-age=3600, stale-while-revalidate=86400",
      },
      body: buildIcs(payload),
    };
  } catch (err) {
    console.error("calendar-ics: " + String((err && err.stack) || err));
    return {
      statusCode: err && err.code === "NO_TOKEN" ? 500 : 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      body: "Calendar unavailable: " + ((err && err.message) || "unknown error") + "\n",
    };
  }
};

// exported for tests
exports.buildIcs = buildIcs;
exports.fold = fold;
exports.esc = esc;
