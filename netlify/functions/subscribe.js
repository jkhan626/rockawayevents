// netlify/functions/subscribe.js  ->  POST /api/subscribe
// Body (JSON or form-encoded): { email, name?, website? }. `website` is a
// honeypot: a filled one is a bot, so we return 200 silently without adding
// the contact. Adds the email to the Resend audience for the weekly list.
// Same-origin only, so no CORS headers are needed.

const { addContact } = require("./lib/email");

// Best-effort in-memory rate limit: 5 calls per minute per IP. This resets on
// every cold start and is not shared across function instances, which is
// fine for its purpose (blunting a script kiddie, not a real defense).
const HITS = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 5;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  // Keep the map from growing forever across a long-lived instance.
  if (HITS.size > 5000) HITS.clear();
  return hits.length > MAX_PER_WINDOW;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

function clientIp(event) {
  const h = (event && event.headers) || {};
  const xff = h["x-forwarded-for"] || h["X-Forwarded-For"];
  if (xff) return String(xff).split(",")[0].trim();
  return (event && event.ip) || "unknown";
}

function parseBody(event) {
  const raw = (event && event.body) || "";
  const ct = ((event && event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  // application/x-www-form-urlencoded (and a reasonable fallback for anything else)
  const out = {};
  for (const pair of String(raw).split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    if (!k) continue;
    out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent((v || "").replace(/\+/g, " "));
  }
  return out;
}

function cleanEmail(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase().slice(0, 200);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

exports.handler = async (event) => {
  const method = (event && event.httpMethod) || "GET";
  if (method !== "POST") {
    return json(405, { ok: false, error: "Use POST" });
  }

  if (rateLimited(clientIp(event))) {
    return json(429, { ok: false, error: "Too many requests, try again in a minute." });
  }

  const data = parseBody(event);

  // Honeypot: a filled hidden field means a bot filled the form. Pretend
  // success so the bot doesn't learn anything, but do nothing.
  if (String(data.website || "").trim()) {
    console.log("subscribe: honeypot filled, dropping");
    return json(200, { ok: true });
  }

  const email = cleanEmail(data.email);
  if (!email) {
    return json(400, { ok: false, error: "A valid email is required." });
  }
  const firstName = String(data.name || "").trim().slice(0, 120) || undefined;

  const result = await addContact({ email, firstName });
  if (!result.ok) {
    // A missing RESEND_AUDIENCE_ID/key is a server config problem, not the
    // caller's fault, but we still can't claim success.
    return json(502, { ok: false, error: result.error || "Could not subscribe right now." });
  }

  return json(200, { ok: true });
};

// exported for tests
exports.cleanEmail = cleanEmail;
exports.parseBody = parseBody;
