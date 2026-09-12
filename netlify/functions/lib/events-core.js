// netlify/functions/lib/events-core.js
// The single source of truth for the public events list. Shared by events.js
// (/api/events), calendar-ics.js (/api/calendar.ics) and rss.js (/api/feed.xml)
// so all three always agree.
//
// Pipeline:
//   1. query the new curated DB (Status = Approved) and the legacy NYC-wide DB
//      (Neighborhood = Rockaway, Status != Skip) in parallel
//   2. normalize both into the Event shape from CLAUDE.md
//   3. expand Weekly / Monthly recurring rows into concrete occurrences
//   4. clip to the window today .. today+60 (America/New_York)
//   5. dedup near-duplicates across the merged list
//   6. sort by date, then start time, then title

const N = require("./notion");

const WINDOW_DAYS = 60;
const DEFAULT_DURATION_MIN = 120; // used by the .ics feed for timed events

/* ---- the Image column -------------------------------------------------- */

// Sentinel written by enrich-images.js when a page turned out to have no
// usable og:image. It exists only so the nightly job stops re-fetching that
// page; to the public feed it means "no image", same as an empty column.
const IMAGE_NONE = "https://rockawayevents.org/img/none";

// Instagram and Facebook CDN URLs are signed and expire within days, and both
// hosts refuse hotlinking. One must never reach the frontend even if something
// upstream writes it into Notion by hand, so this is a hard reject rather than
// a lint. Instagram post photos are served from our own /img/ig/ instead.
const EXPIRING_CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

// Normalize whatever sits in an Image column to a usable public URL or null.
function cleanImage(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (s === IMAGE_NONE) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null; // not a URL at all
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (EXPIRING_CDN.test(u.hostname)) return null;
  return s;
}

/* ---- legacy "Type" -> our "Category" ----------------------------------- */

// The legacy DB's Type multi_select is free-form (an LLM routine writes it), so
// this table is keyed on lowercased Type names and is deliberately generous.
// Anything unmatched falls through to a substring pass, then to "Other".
const TYPE_TO_CATEGORY = {
  // Music
  music: "Music",
  "live music": "Music",
  concert: "Music",
  concerts: "Music",
  dj: "Music",
  band: "Music",
  jazz: "Music",
  karaoke: "Music",
  // Food & Drink
  food: "Food & Drink",
  drink: "Food & Drink",
  drinks: "Food & Drink",
  "food & drink": "Food & Drink",
  "food and drink": "Food & Drink",
  restaurant: "Food & Drink",
  dining: "Food & Drink",
  beer: "Food & Drink",
  brewery: "Food & Drink",
  wine: "Food & Drink",
  tasting: "Food & Drink",
  brunch: "Food & Drink",
  // Run & Fitness
  fitness: "Run & Fitness",
  run: "Run & Fitness",
  running: "Run & Fitness",
  "run club": "Run & Fitness",
  race: "Run & Fitness",
  "5k": "Run & Fitness",
  marathon: "Run & Fitness",
  yoga: "Run & Fitness",
  pilates: "Run & Fitness",
  workout: "Run & Fitness",
  bootcamp: "Run & Fitness",
  wellness: "Run & Fitness",
  // Surf & Beach
  beach: "Surf & Beach",
  surf: "Surf & Beach",
  surfing: "Surf & Beach",
  swim: "Surf & Beach",
  swimming: "Surf & Beach",
  paddle: "Surf & Beach",
  kayak: "Surf & Beach",
  // Kids & Family
  kids: "Kids & Family",
  family: "Kids & Family",
  "kids & family": "Kids & Family",
  "kids and family": "Kids & Family",
  children: "Kids & Family",
  "story time": "Kids & Family",
  // Arts & Culture
  art: "Arts & Culture",
  arts: "Arts & Culture",
  theater: "Arts & Culture",
  theatre: "Arts & Culture",
  film: "Arts & Culture",
  movie: "Arts & Culture",
  movies: "Arts & Culture",
  comedy: "Arts & Culture",
  museum: "Arts & Culture",
  gallery: "Arts & Culture",
  culture: "Arts & Culture",
  books: "Arts & Culture",
  literary: "Arts & Culture",
  reading: "Arts & Culture",
  dance: "Arts & Culture",
  workshop: "Arts & Culture",
  class: "Arts & Culture",
  // Market
  market: "Market",
  markets: "Market",
  flea: "Market",
  "flea market": "Market",
  "farmers market": "Market",
  "farmers' market": "Market",
  craft: "Market",
  "craft fair": "Market",
  shopping: "Market",
  vendors: "Market",
  // Nightlife
  party: "Nightlife",
  nightlife: "Nightlife",
  bar: "Nightlife",
  club: "Nightlife",
  trivia: "Nightlife",
  "happy hour": "Nightlife",
  // Volunteer
  volunteer: "Volunteer",
  volunteering: "Volunteer",
  cleanup: "Volunteer",
  "clean up": "Volunteer",
  "clean-up": "Volunteer",
  "beach cleanup": "Volunteer",
  service: "Volunteer",
  charity: "Volunteer",
  // Outdoors
  outdoors: "Outdoors",
  outdoor: "Outdoors",
  nature: "Outdoors",
  park: "Outdoors",
  parks: "Outdoors",
  hike: "Outdoors",
  hiking: "Outdoors",
  walk: "Outdoors",
  garden: "Outdoors",
  gardening: "Outdoors",
  birding: "Outdoors",
  "bird watching": "Outdoors",
  bike: "Outdoors",
  cycling: "Outdoors",
  // Sports
  sports: "Sports",
  sport: "Sports",
  game: "Sports",
  baseball: "Sports",
  basketball: "Sports",
  soccer: "Sports",
  football: "Sports",
  hockey: "Sports",
  tennis: "Sports",
  skate: "Sports",
  skateboarding: "Sports",
  // Community
  community: "Community",
  festival: "Community",
  fair: "Community",
  parade: "Community",
  meeting: "Community",
  "town hall": "Community",
  fundraiser: "Community",
  holiday: "Community",
  civic: "Community",
};

// Ordered longest-first so "beach cleanup" wins over "beach" in the substring pass.
const TYPE_KEYS_BY_LENGTH = Object.keys(TYPE_TO_CATEGORY).sort(
  (a, b) => b.length - a.length
);

// Map one legacy Type name to a Category, or null when nothing plausible matches.
function mapType(typeName) {
  const t = String(typeName || "").toLowerCase().trim();
  if (!t) return null;
  if (TYPE_TO_CATEGORY[t]) return TYPE_TO_CATEGORY[t];
  for (const k of TYPE_KEYS_BY_LENGTH) {
    if (t.includes(k)) return TYPE_TO_CATEGORY[k];
  }
  return null;
}

// Map a whole legacy Type array to a deduped Category array. Never returns [].
function mapTypes(types) {
  const out = [];
  for (const t of types || []) {
    const c = mapType(t);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.length ? out : ["Other"];
}

/* ---- free-text time -> "HH:MM" ----------------------------------------- */

// The Time column is human prose ("7:30 PM", "9am", "9 AM to 1 PM", "Doors 8",
// "6-10pm", "Noon"). Pull out the FIRST clock time and return 24h "HH:MM", or
// null when there is nothing clock-like in there.
function parseTimeStart(text) {
  let s = String(text || "").toLowerCase();
  if (!s) return null;

  // Word times first, so "noon to 4pm" resolves to 12:00 rather than 4:00.
  s = s.replace(/\bnoon\b/g, "12:00pm").replace(/\bmidnight\b/g, "12:00am");

  // (?!\d) after the optional minutes keeps us out of years and long numbers:
  // "2026" and "10000" never look like a time.
  const TIME_RE = /(\d{1,2})(?::(\d{2}))?(?!\d)\s*(a\.?m\.?|p\.?m\.?)?/g;
  const MERIDIEM_RE = /(a\.?m\.?|p\.?m\.?)/g;

  let m;
  while ((m = TIME_RE.exec(s)) !== null) {
    const hasColon = m[2] !== undefined;
    let h = Number(m[1]);
    const min = hasColon ? Number(m[2]) : 0;
    let mer = m[3] ? m[3][0] : null; // "a" or "p"

    // Skip ordinals and dates: "Beach 96th", "Sept 12", "3rd floor".
    const after = s.slice(TIME_RE.lastIndex);
    if (!hasColon && !mer && /^\s*(st|nd|rd|th)\b/.test(after)) continue;
    if (min > 59) continue;

    // No meridiem glued to this time: borrow the next one in the string, so
    // "6 - 10pm" reads as 6 PM and "9 AM to 1 PM" keeps its own AM.
    if (!mer) {
      MERIDIEM_RE.lastIndex = m.index;
      const next = MERIDIEM_RE.exec(s);
      if (next) mer = next[1][0];
    }

    if (mer === "p") {
      if (h === 12) h = 12;
      else if (h < 12) h += 12;
      else if (h > 12) continue; // "13 pm" is nonsense
    } else if (mer === "a") {
      if (h === 12) h = 0;
      else if (h > 12) continue;
    } else if (h > 23) {
      continue;
    } else if (!hasColon && h >= 1 && h <= 6) {
      // A bare evening-ish hour with no meridiem anywhere ("Doors at 6").
      // Rockaway events at 1 through 6 are overwhelmingly PM.
      h += 12;
    }

    if (h > 23) continue;
    return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
  }
  return null;
}

/* ---- recurring expansion ----------------------------------------------- */

// Which occurrence of its weekday a date is within its month (1 = 1st Saturday).
function nthWeekdayOfMonth(ymd) {
  return Math.floor((Number(String(ymd).slice(8, 10)) - 1) / 7) + 1;
}

// The date of the nth given weekday in year/month, or null when the month has
// no such occurrence (e.g. no 5th Saturday).
function nthWeekdayDate(year, month1, dow, nth) {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const shift = (dow - first.getUTCDay() + 7) % 7;
  const day = 1 + shift + (nth - 1) * 7;
  const dt = new Date(Date.UTC(year, month1 - 1, day));
  if (dt.getUTCMonth() !== month1 - 1) return null;
  return dt.toISOString().slice(0, 10);
}

// Expand one recurring row into the concrete dates it falls on inside
// [windowStart, windowEnd]. Date bounds the series start, End Date its end.
function occurrenceDates(row, windowStart, windowEnd) {
  const seriesStart =
    row.date && row.date > windowStart ? row.date : windowStart;
  const seriesEnd =
    row.dateEnd && row.dateEnd < windowEnd ? row.dateEnd : windowEnd;
  if (seriesStart > seriesEnd) return [];

  const dates = [];

  if (row.recurring === "Weekly") {
    // Days drives it. With no Days set, fall back to the weekday of Date.
    let wanted = new Set(
      (row.days || [])
        .map((d) => N.DAY_NAMES.indexOf(String(d).slice(0, 3)))
        .filter((i) => i >= 0)
    );
    if (!wanted.size) {
      if (!row.date) return [];
      wanted = new Set([N.dowOf(row.date)]);
    }
    for (let d = seriesStart; d <= seriesEnd; d = N.addDays(d, 1)) {
      if (wanted.has(N.dowOf(d))) dates.push(d);
    }
    return dates;
  }

  if (row.recurring === "Monthly") {
    // "same weekday-of-month as Date", e.g. 2nd Saturday. Needs Date to know
    // which pattern to repeat.
    if (!row.date) return [];
    const dow = N.dowOf(row.date);
    const nth = nthWeekdayOfMonth(row.date);
    let y = Number(seriesStart.slice(0, 4));
    let mo = Number(seriesStart.slice(5, 7));
    const endY = Number(seriesEnd.slice(0, 4));
    const endMo = Number(seriesEnd.slice(5, 7));
    while (y * 12 + mo <= endY * 12 + endMo) {
      const d = nthWeekdayDate(y, mo, dow, nth);
      if (d && d >= seriesStart && d <= seriesEnd) dates.push(d);
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
    }
    return dates;
  }

  return dates;
}

/* ---- normalization ----------------------------------------------------- */

function newDbRow(page) {
  const dp = N.getDateParts(page, "Date");
  const ep = N.getDateParts(page, "End Date");
  const timeText = N.getText(page, "Time");
  const recurringRaw = N.getSelect(page, "Recurring") || "None";
  const recurring = ["Weekly", "Monthly"].includes(recurringRaw)
    ? recurringRaw
    : "None";
  return {
    _db: "new",
    id: page.id,
    event: N.getTitle(page, "Event"),
    date: dp.date,
    dateEnd: ep.date || dp.end || null,
    time: timeText,
    // A time embedded in the Date property is authoritative; prose is the fallback.
    timeStart: dp.time || parseTimeStart(timeText),
    venue: N.getText(page, "Venue"),
    address: N.getText(page, "Address"),
    category: N.getMulti(page, "Category"),
    cost: N.getText(page, "Cost"),
    free: N.getCheckbox(page, "Free"),
    url: N.getUrl(page, "URL"),
    instagram: N.getUrl(page, "Instagram"),
    image: cleanImage(N.getUrl(page, "Image")),
    description: N.getText(page, "Description"),
    source: N.getSelect(page, "Source") || "Jamal",
    featured: N.getCheckbox(page, "Featured"),
    recurring,
    days: N.getMulti(page, "Days"),
  };
}

function legacyDbRow(page) {
  const dp = N.getDateParts(page, "Date");
  const ep = N.getDateParts(page, "End Date");
  const timeText = N.getText(page, "Time");
  // The routine marks its picks with a leading star glyph (U+2B50, sometimes
  // with a variation selector). Strip it so titles read plainly on the site.
  const rawTitle = N.getTitle(page, "Event");
  const event = rawTitle.replace(/^[\s⭐★☆️]+/, "").trim();
  const cost = N.getText(page, "Cost");
  return {
    _db: "legacy",
    id: page.id,
    event,
    date: dp.date,
    dateEnd: ep.date || dp.end || null,
    time: timeText,
    timeStart: dp.time || parseTimeStart(timeText),
    venue: N.getText(page, "Venue"),
    address: "", // legacy DB has no Address column
    category: mapTypes(N.getMulti(page, "Type")),
    cost,
    free: /\bfree\b/i.test(cost),
    url: N.getUrl(page, "URL"),
    instagram: null,
    // The legacy DB grew an Image column so enrich-images can fill it too.
    image: cleanImage(N.getUrl(page, "Image")),
    description: N.getText(page, "Description"),
    source: "Routine",
    featured: false,
    recurring: "None",
    days: [],
  };
}

// Turn a normalized row into the public Event objects it produces: one for a
// single/multi-day event, N occurrences for a recurring series.
function toEvents(row, windowStart, windowEnd) {
  if (row.recurring === "Weekly" || row.recurring === "Monthly") {
    return occurrenceDates(row, windowStart, windowEnd).map((d) =>
      Object.assign({}, row, {
        id: row.id + "_" + d,
        seriesId: row.id,
        date: d,
        dateEnd: null,
      })
    );
  }
  if (!row.date) return [];
  // Multi-day events stay visible while dateEnd >= today; single-day ones must
  // fall inside the window.
  const endsAt = row.dateEnd && row.dateEnd > row.date ? row.dateEnd : row.date;
  if (endsAt < windowStart) return [];
  if (row.date > windowEnd) return [];
  return [row];
}

/* ---- dedup ------------------------------------------------------------- */

// Ported from jamasha's events.js. Normalize a title to a canonical key:
// lowercase, split on separators, drop words of 3 chars or less, sort, take 5.
// "Shakespeare in the Park: Romeo and Juliet" and "Romeo and Juliet -
// Shakespeare in the Park" both collapse to "and juliet park romeo shakespeare".
function titleKey(s) {
  if (!s) return "";
  let t = String(s).toLowerCase();
  for (const ch of [":", "|", "—", "–", "-", "(", ")", '"', "'", "/", ","]) {
    t = t.split(ch).join(" ");
  }
  const all = t.split(/\s+/).filter(Boolean);
  const words = all.filter((w) => w.length > 3);
  // DEVIATION from jamasha, and a real bug fix: a title built only from short
  // words ("Fun in the Sun", "Art on the Bay", "Open Mic") leaves nothing after
  // the length filter, so every such event on a given date used to share the
  // empty key and collapse into one. Fall back to the whole normalized title,
  // which keeps terse titles distinct while richer titles stay fuzzy.
  const chosen = words.length ? words.slice().sort().slice(0, 5) : all.slice().sort();
  return chosen.join(" ");
}

function venueKey(s) {
  return String(s || "").toLowerCase().trim().slice(0, 40);
}

// Which of two colliding events to keep. Lower rank wins.
//   1. the curated new DB beats the legacy routine DB
//   2. a concrete one-off row beats a generated recurring occurrence
//      (the one-off carries the real title, image and description)
//   3. otherwise the largest Notion id, i.e. the most recently created row
function keepRank(e) {
  return (e._db === "new" ? 0 : 1) * 2 + (e.seriesId ? 1 : 0);
}

// Union-find dedup over the merged list, same shape as jamasha's dedupEvents.
//
// DEVIATION from jamasha, deliberate: jamasha unions on (date, venue) alone.
// On this site one venue hosts several distinct things a night (Riis Park,
// Rockaway Beach Surf Club), so date+venue alone silently swallows real events.
// The venue bucket here additionally requires the same start time (both null
// counts as the same), which still catches the "same event, different wording"
// case the venue rule exists for. The title bucket is unchanged.
function dedupEvents(list) {
  const byTitle = new Map();
  const byVenue = new Map();
  for (const e of list) {
    const tk = (e.date || "_") + "::T::" + titleKey(e.event);
    if (!byTitle.has(tk)) byTitle.set(tk, []);
    byTitle.get(tk).push(e);
    if (e.venue) {
      const vk =
        (e.date || "_") + "::V::" + venueKey(e.venue) + "::" + (e.timeStart || "-");
      if (!byVenue.has(vk)) byVenue.set(vk, []);
      byVenue.get(vk).push(e);
    }
  }

  const parent = new Map();
  for (const e of list) parent.set(e.id, e.id);
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const bucket of [...byTitle.values(), ...byVenue.values()]) {
    for (let i = 1; i < bucket.length; i++) union(bucket[0].id, bucket[i].id);
  }

  const groups = new Map();
  for (const e of list) {
    const r = find(e.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  }

  const kept = [];
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const d = keepRank(a) - keepRank(b);
      if (d) return d;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    kept.push(group[0]);
  }
  return kept;
}

/* ---- sort + shape ------------------------------------------------------ */

function sortEvents(list) {
  return list.sort((a, b) => {
    const d = (a.date || "").localeCompare(b.date || "");
    if (d) return d;
    // Events with no known start time sort after timed ones on the same day.
    const at = a.timeStart || "99:99";
    const bt = b.timeStart || "99:99";
    if (at !== bt) return at < bt ? -1 : 1;
    return (a.event || "").localeCompare(b.event || "");
  });
}

// Strip internal bookkeeping and emit exactly the contract's Event shape.
function publicShape(e) {
  const out = {
    id: e.id,
    event: e.event || "",
    date: e.date,
    dateEnd: e.dateEnd || null,
    time: e.time || "",
    timeStart: e.timeStart || null,
    venue: e.venue || "",
    address: e.address || "",
    category: Array.isArray(e.category) && e.category.length ? e.category : ["Other"],
    cost: e.cost || "",
    free: !!e.free,
    url: e.url || null,
    instagram: e.instagram || null,
    image: cleanImage(e.image),
    description: e.description || "",
    source: e.source || "Other",
    featured: !!e.featured,
    recurring: e.recurring || "None",
    days: Array.isArray(e.days) ? e.days : [],
  };
  if (e.seriesId) out.seriesId = e.seriesId;
  return out;
}

/* ---- queries ----------------------------------------------------------- */

// The new DB is small and curated, and its recurring rows can have a Date in
// the past (or none at all), so filtering by date server-side would drop live
// series. Pull every Approved row and clip the window in JS.
function newDbFilter() {
  return { property: "Status", select: { equals: "Approved" } };
}

// Notion allows compound filters two levels deep only, so the shared
// conditions are repeated inside both OR branches (logically identical).
function legacyDbFilter(today) {
  const common = [
    { property: "Neighborhood", select: { equals: "Rockaway" } },
    { property: "Status", select: { does_not_equal: "Skip" } },
  ];
  return {
    or: [
      {
        and: [
          ...common,
          { property: "End Date", date: { is_empty: true } },
          { property: "Date", date: { on_or_after: today } },
        ],
      },
      {
        and: [...common, { property: "End Date", date: { on_or_after: today } }],
      },
    ],
  };
}

/**
 * Fetch, merge, expand, dedup and sort the public events list.
 * Returns { updated, today, count, events, warnings? }.
 * Throws when NOTION_TOKEN is missing or when BOTH databases fail.
 */
async function getEvents(opts) {
  const token = (opts && opts.token) || process.env.NOTION_TOKEN;
  if (!token) {
    const err = new Error("Server not configured: NOTION_TOKEN is missing.");
    err.code = "NO_TOKEN";
    throw err;
  }

  const today = (opts && opts.today) || N.todayET();
  const windowEnd = N.addDays(today, WINDOW_DAYS);
  const warnings = [];

  // Each DB is awaited independently so one outage cannot blank the other.
  const [newRes, legacyRes] = await Promise.allSettled([
    N.queryAll(
      N.NEW_DB_ID,
      { filter: newDbFilter(), sorts: [{ property: "Date", direction: "ascending" }] },
      token
    ),
    N.queryAll(
      N.LEGACY_DB_ID,
      {
        filter: legacyDbFilter(today),
        sorts: [{ property: "Date", direction: "ascending" }],
      },
      token
    ),
  ]);

  if (newRes.status === "rejected" && legacyRes.status === "rejected") {
    const err = new Error("Both Notion databases failed");
    err.code = "BOTH_FAILED";
    err.detail = String(newRes.reason) + " | " + String(legacyRes.reason);
    throw err;
  }

  const rows = [];
  if (newRes.status === "fulfilled") {
    for (const p of newRes.value) rows.push(newDbRow(p));
  } else {
    warnings.push("curated database unavailable: " + String(newRes.reason));
  }
  if (legacyRes.status === "fulfilled") {
    for (const p of legacyRes.value) rows.push(legacyDbRow(p));
  } else {
    warnings.push("routine database unavailable: " + String(legacyRes.reason));
  }

  let events = [];
  for (const row of rows) {
    if (!row.event) continue; // an untitled row is a draft, not an event
    events.push(...toEvents(row, today, windowEnd));
  }

  events = sortEvents(dedupEvents(events)).map(publicShape);

  const payload = {
    updated: new Date().toISOString(),
    today,
    count: events.length,
    events,
  };
  if (warnings.length) payload.warnings = warnings;
  return payload;
}

module.exports = {
  getEvents,
  // exported for the sibling functions and for tests
  IMAGE_NONE,
  EXPIRING_CDN,
  cleanImage,
  WINDOW_DAYS,
  DEFAULT_DURATION_MIN,
  TYPE_TO_CATEGORY,
  mapType,
  mapTypes,
  parseTimeStart,
  occurrenceDates,
  nthWeekdayOfMonth,
  nthWeekdayDate,
  newDbRow,
  legacyDbRow,
  toEvents,
  titleKey,
  venueKey,
  dedupEvents,
  sortEvents,
  publicShape,
  newDbFilter,
  legacyDbFilter,
};
