// netlify/functions/lib/auth.js
// Shared moderation-key check for /api/pending and /api/moderate.

const { createHash, timingSafeEqual } = require("crypto");

// Compare two secrets without leaking length or prefix through timing. Hashing
// both sides first gives timingSafeEqual two equal-length buffers, so differing
// lengths cannot throw or short-circuit.
function sameSecret(a, b) {
  const ha = createHash("sha256").update(String(a == null ? "" : a)).digest();
  const hb = createHash("sha256").update(String(b == null ? "" : b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Check a caller-supplied key against MODERATE_KEY.
 * Returns null when authorized, or a ready-to-return 401/500 response.
 */
function requireKey(key) {
  const expected = process.env.MODERATE_KEY;
  if (!expected) {
    console.error("auth: MODERATE_KEY is not set");
    return deny(500, "Server not configured: MODERATE_KEY is missing.");
  }
  // An empty submitted key is always wrong, even if it somehow matched.
  if (!key || !sameSecret(key, expected)) return deny(401, "Unauthorized");
  return null;
}

function deny(statusCode, message) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
    body: JSON.stringify({ error: message }),
  };
}

// Every moderation response is private and must never be cached or indexed.
const privateJson = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  },
  body: JSON.stringify(obj),
});

module.exports = { sameSecret, requireKey, privateJson };
