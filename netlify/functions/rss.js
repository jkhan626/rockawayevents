// netlify/functions/rss.js  ->  GET /api/feed.xml
// RSS 2.0 of the upcoming events, same list /api/events serves.

const { getEvents } = require("./lib/events-core");

const SITE = "https://rockawayevents.org";
const FEED_URL = SITE + "/feed.xml";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Escape for XML text and attribute content.
function xml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// "Sat, Sep 12" for the item title.
function dateLabel(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return DOWS[dt.getUTCDay()] + ", " + MONTHS[m - 1] + " " + d;
}

// RFC 822 pubDate for the event's own date and start time, read as America/New_York.
// EDT runs the second Sunday of March to the first Sunday of November.
function isEdt(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  if (m > 3 && m < 11) return true;
  if (m < 3 || m > 11) return false;
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  if (m === 3) {
    const secondSunday = 1 + ((7 - firstDow) % 7) + 7;
    return d >= secondSunday;
  }
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return d < firstSunday;
}

function pubDate(ymd, hhmm) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const [h, mi] = (hhmm || "09:00").split(":").map(Number);
  const offsetHours = isEdt(ymd) ? 4 : 5;
  return new Date(Date.UTC(y, m - 1, d, h + offsetHours, mi)).toUTCString();
}

// The item description is HTML, so it is escaped once for HTML and then the
// whole blob is escaped again by xml() when it goes into the element.
function itemHtml(e) {
  const p = [];
  const when = [dateLabel(e.date), e.time].filter(Boolean).join(", ");
  const where = [e.venue, e.address].filter(Boolean).join(", ");
  p.push("<p><strong>" + xml(when) + "</strong></p>");
  if (where) p.push("<p>" + xml(where) + "</p>");
  // Keep the author's line breaks: each blank-line-separated block becomes its
  // own paragraph, single newlines become <br />.
  if (e.description) {
    for (const block of String(e.description).split(/\n\s*\n/)) {
      const text = block.trim();
      if (text) p.push("<p>" + xml(text).split("\n").join("<br />") + "</p>");
    }
  }
  const meta = [];
  if (e.free) meta.push("Free");
  else if (e.cost) meta.push(xml(e.cost));
  if (Array.isArray(e.category) && e.category.length) {
    meta.push(e.category.map(xml).join(", "));
  }
  if (meta.length) p.push("<p>" + meta.join(" | ") + "</p>");
  if (e.url) p.push('<p><a href="' + xml(e.url) + '">More info</a></p>');
  return p.join("");
}

function buildRss(payload) {
  const updated = new Date(payload.updated || Date.now()).toUTCString();
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  out.push("<channel>");
  out.push("<title>Rockaway Events</title>");
  out.push("<link>" + SITE + "</link>");
  out.push(
    "<description>Everything happening on the Rockaway peninsula: events, markets, run clubs, surf and beach days.</description>"
  );
  out.push("<language>en-us</language>");
  out.push("<lastBuildDate>" + updated + "</lastBuildDate>");
  out.push("<generator>rockawayevents.org</generator>");
  out.push('<atom:link href="' + FEED_URL + '" rel="self" type="application/rss+xml" />');

  for (const e of payload.events || []) {
    if (!e.date) continue;
    const link = SITE + "/#e=" + encodeURIComponent(e.id);
    out.push("<item>");
    out.push("<title>" + xml(dateLabel(e.date) + " · " + e.event) + "</title>");
    out.push("<link>" + xml(link) + "</link>");
    out.push("<description>" + xml(itemHtml(e)) + "</description>");
    out.push("<pubDate>" + pubDate(e.date, e.timeStart) + "</pubDate>");
    out.push('<guid isPermaLink="false">' + xml("rockawayevents.org/" + e.id) + "</guid>");
    for (const c of e.category || []) out.push("<category>" + xml(c) + "</category>");
    out.push("</item>");
  }

  out.push("</channel>");
  out.push("</rss>");
  return out.join("\n") + "\n";
}

exports.handler = async () => {
  try {
    const payload = await getEvents();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "Netlify-CDN-Cache-Control":
          "public, max-age=3600, stale-while-revalidate=86400",
      },
      body: buildRss(payload),
    };
  } catch (err) {
    console.error("rss: " + String((err && err.stack) || err));
    return {
      statusCode: err && err.code === "NO_TOKEN" ? 500 : 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      body: "Feed unavailable: " + ((err && err.message) || "unknown error") + "\n",
    };
  }
};

// exported for tests
exports.buildRss = buildRss;
exports.pubDate = pubDate;
exports.dateLabel = dateLabel;
