// netlify/functions/lib/notion.js
// Shared Notion REST helpers for rockawayevents.org. Zero npm dependencies:
// Node 20's global fetch only. The NOTION_TOKEN never leaves the server.

const NOTION_VERSION = "2022-06-28";

// New public DB: "Rockaway Events (rockawayevents.org)" — curated, Status-gated.
const NEW_DB_ID = "c83a031ec6644f04a21800790660c9d4";
// Legacy NYC-wide DB: "Events & Happenings" — filled by the 3:10 AM ET routine.
const LEGACY_DB_ID = "bf66333b0ca142ffb28233fdb5774e64";

const NOTION_API = "https://api.notion.com/v1";

// The Category multi_select options in the new DB, in display order.
const CATEGORIES = [
  "Music",
  "Food & Drink",
  "Run & Fitness",
  "Surf & Beach",
  "Kids & Family",
  "Arts & Culture",
  "Community",
  "Market",
  "Nightlife",
  "Volunteer",
  "Outdoors",
  "Sports",
  "Other",
];

// Days multi_select options, index-aligned to JS getUTCDay() (0 = Sunday).
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---- date helpers (string math, so no local-timezone drift) ------------- */

// Today as YYYY-MM-DD in America/New_York.
function todayET() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Shift a YYYY-MM-DD string by n days. Done in UTC so DST never shifts a date.
function addDays(ymd, n) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Day of week for a YYYY-MM-DD string, 0 = Sunday.
function dowOf(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// True when ymd is a real calendar date (rejects 2026-02-31).
function isValidYmd(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return false;
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/* ---- property readers -------------------------------------------------- */

// Flatten a Notion rich_text / title array to a trimmed plain string.
const plain = (rich) =>
  Array.isArray(rich)
    ? rich.map((t) => (t && t.plain_text) || "").join("").trim()
    : "";

// Every getter below tolerates a missing property (renamed column, partial page
// object, brand-new row) and returns a neutral value instead of throwing.
const prop = (page, name) => ((page && page.properties) || {})[name] || {};

const getTitle = (page, name) => plain(prop(page, name).title);
const getText = (page, name) => plain(prop(page, name).rich_text);
const getSelect = (page, name) => {
  const s = prop(page, name).select;
  return (s && s.name) || null;
};
const getMulti = (page, name) => {
  const m = prop(page, name).multi_select;
  return Array.isArray(m) ? m.map((o) => o && o.name).filter(Boolean) : [];
};
const getUrl = (page, name) => prop(page, name).url || null;
const getEmail = (page, name) => prop(page, name).email || null;
const getCheckbox = (page, name) => prop(page, name).checkbox === true;
const getNumber = (page, name) => {
  const n = prop(page, name).number;
  return typeof n === "number" ? n : null;
};
const getCreatedTime = (page, name) => prop(page, name).created_time || null;

// A Notion date property's `start` may be a bare date ("2026-09-12") or a full
// timestamp ("2026-09-12T19:00:00.000-04:00"). Return the halves separately;
// the time half is a free extra source for the event's timeStart.
function getDateParts(page, name) {
  const d = prop(page, name).date;
  const raw = (d && d.start) || null;
  if (!raw) return { date: null, time: null, end: null };
  const date = String(raw).slice(0, 10);
  let time = null;
  if (String(raw).length > 10 && String(raw)[10] === "T") {
    const hh = String(raw).slice(11, 13);
    const mm = String(raw).slice(14, 16);
    if (/^\d{2}$/.test(hh) && /^\d{2}$/.test(mm)) time = hh + ":" + mm;
  }
  return { date, time, end: d && d.end ? String(d.end).slice(0, 10) : null };
}

const getDate = (page, name) => getDateParts(page, name).date;

/* ---- HTTP -------------------------------------------------------------- */

class NotionError extends Error {
  constructor(status, detail) {
    super("Notion API " + status + ": " + detail);
    this.name = "NotionError";
    this.status = status;
    this.detail = detail;
  }
}

async function notionFetch(path, opts) {
  const { method = "POST", body, token, timeoutMs = 10000 } = opts || {};
  if (!token) throw new Error("NOTION_TOKEN is missing");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(NOTION_API + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new NotionError(res.status, await res.text());
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Query a database, following next_cursor until every page is collected.
// `body` is merged into each request (filter, sorts, page_size).
async function queryAll(databaseId, body, token) {
  const base = Object.assign({ page_size: 100 }, body || {});
  const results = [];
  let cursor;
  let guard = 0;
  do {
    const data = await notionFetch("/databases/" + databaseId + "/query", {
      method: "POST",
      body: cursor ? Object.assign({}, base, { start_cursor: cursor }) : base,
      token,
    });
    if (Array.isArray(data.results)) results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor && ++guard < 50);
  return results;
}

// Create a page in a database. `properties` is a raw Notion properties object.
function createPage(databaseId, properties, token) {
  return notionFetch("/pages", {
    method: "POST",
    body: { parent: { database_id: databaseId }, properties },
    token,
  });
}

// Patch a page's properties.
function updatePage(pageId, properties, token) {
  return notionFetch("/pages/" + pageId, {
    method: "PATCH",
    body: { properties },
    token,
  });
}

/* ---- property writers (for createPage / updatePage) -------------------- */

const wRich = (s) => ({
  rich_text: [{ type: "text", text: { content: String(s) } }],
});
const wTitle = (s) => ({ title: [{ type: "text", text: { content: String(s) } }] });
const wSelect = (name) => ({ select: name ? { name: String(name) } : null });
const wMulti = (names) => ({
  multi_select: (names || []).map((n) => ({ name: String(n) })),
});
const wDate = (start, end) => ({
  date: start ? Object.assign({ start }, end ? { end } : {}) : null,
});
const wUrl = (u) => ({ url: u || null });
const wEmail = (e) => ({ email: e || null });
const wCheckbox = (b) => ({ checkbox: !!b });

module.exports = {
  NOTION_VERSION,
  NEW_DB_ID,
  LEGACY_DB_ID,
  CATEGORIES,
  DAY_NAMES,
  NotionError,
  todayET,
  addDays,
  dowOf,
  isValidYmd,
  plain,
  prop,
  getTitle,
  getText,
  getSelect,
  getMulti,
  getUrl,
  getEmail,
  getCheckbox,
  getNumber,
  getCreatedTime,
  getDateParts,
  getDate,
  notionFetch,
  queryAll,
  createPage,
  updatePage,
  write: {
    rich: wRich,
    title: wTitle,
    select: wSelect,
    multi: wMulti,
    date: wDate,
    url: wUrl,
    email: wEmail,
    checkbox: wCheckbox,
  },
};
