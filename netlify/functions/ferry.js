// netlify/functions/ferry.js  ->  GET /api/ferry
// NYC Ferry Rockaway departures. Copied from jamasha's wrapper; the GTFS
// parsing lives in lib/ferry-core.js (also copied), which unpacks the official
// static GTFS zip through lib/unzip.js instead of the fflate npm package.
//
// Returns the timetable for ?date=YYYY-MM-DD (ET), defaulting to today. No auth
// (public data).

const { getFerrySchedule } = require("./lib/ferry-core");

const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    // Schedule is static-ish; let the CDN cache so we don't re-pull GTFS per hit.
    "Cache-Control": "public, max-age=21600",
  },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  try {
    const q = (event && event.queryStringParameters) || {};
    const payload = await getFerrySchedule(q.date);
    return json(200, payload);
  } catch (err) {
    const msg = String((err && err.message) || err);
    return json(/^GTFS fetch \d+$/.test(msg) ? 502 : 500, { error: msg });
  }
};
