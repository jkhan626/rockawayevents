// netlify/functions/events.js  ->  GET /api/events
// The public events feed. All the real work lives in lib/events-core.js, which
// calendar-ics.js and rss.js share, so every surface shows the same list.

const { getEvents } = require("./lib/events-core");

exports.handler = async () => {
  try {
    const payload = await getEvents();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Browsers cache 5 min; Netlify's CDN serves a cached copy for 10 min
        // and revalidates in the background so the page stays snappy.
        "Cache-Control": "public, max-age=300",
        "Netlify-CDN-Cache-Control":
          "public, max-age=600, stale-while-revalidate=3600",
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    const status = err && err.code === "NO_TOKEN" ? 500 : 502;
    console.error("events: " + String((err && err.stack) || err));
    return {
      statusCode: status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: (err && err.message) || "Failed to load events",
        detail: (err && err.detail) || undefined,
      }),
    };
  }
};
