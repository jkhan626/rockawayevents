// netlify/functions/enrich-images.js
//
// Fills the Image column of both event databases from the og:image of each
// event's own page, so the feed shows real photos instead of generated posters.
//
// Two ways in:
//   - Netlify scheduled invocation (see [functions."enrich-images"] in
//     netlify.toml). Netlify POSTs a body of {"next_run": "..."} and sends no
//     query string, which is exactly how we recognise it.
//   - GET /api/enrich-images?key=<MODERATE_KEY> for a manual run. Optional
//     &limit=N and &dry=1.
//
// Per row: fetch the event page (8 s timeout, browser-like UA, first 200 KB
// only), pull og:image / og:image:secure_url / twitter:image / link[rel=image_src],
// resolve it against the page URL, confirm it really is an image, then
// PATCH it onto the Notion page. A page that yields nothing gets the sentinel
// IMAGE_NONE so tomorrow's run does not fetch it again; events-core reads that
// sentinel back as image: null.
//
// Instagram is deliberately never scraped here. Instagram CDN URLs
// (scontent-*.cdninstagram.com, *.fbcdn.net) are signed, expire within days and
// refuse hotlinking, so writing one into Notion would produce a card that
// breaks a few days later. Instagram rows are skipped with NO sentinel, so the
// separate local task that downloads the post photo into dist/img/ig/ can still
// claim them later.

const N = require("./lib/notion");
const { IMAGE_NONE, cleanImage } = require("./lib/events-core");
const { requireKey } = require("./lib/auth");

/* ---- tunables ---------------------------------------------------------- */

const MAX_ROWS = 40; // rows touched per run, oldest event first
const POOL = 8; // pages fetched at once
const PAGE_TIMEOUT_MS = 8000;
const HEAD_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 200 * 1024;
const MIN_IMAGE_BYTES = 200;
const MAX_CANDIDATES = 4; // og:image, twitter:image, ... give up after this many
// Netlify cuts a function off well before a minute, and the two ways in do not
// get the same room: a scheduled invocation has the longer allowance, a
// synchronous GET through /api/ has the short one. Stop starting new rows once
// the budget is gone and report what did land; whatever was not reached is
// picked up by the next run, so a short manual run costs nothing.
const BUDGET_SCHEDULED_MS = 20000;
const BUDGET_MANUAL_MS = 7500;

// A real browser UA. Eventbrite, Squarespace and most WordPress security
// plugins serve a stub or a 403 to anything that announces itself as a bot.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PAGE_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Hosts we never scrape (see the note at the top of the file).
const SKIP_HOSTS = /(^|\.)(instagram\.com|instagr\.am|cdninstagram\.com|fbcdn\.net)$/i;

// Sites whose og:image is one fixed brand image for the whole site rather than
// anything to do with the event on the page. Scraping them is worse than not
// scraping them: the card ends up as a stretched logo, where leaving the row
// empty lets the venue or category photo take over and the grid stays readable.
// Verified by hand against the live feed on 2026-09-12; add a host here only
// after checking that its og:image really is site-wide.
//   eatrippers.com       -> Rippers_Vector_Logo_g.png
//   tapthatrbny.com      -> Home-Page-Logo.png
//   connollysrbny.com    -> Felix_the_Cat_Color.png
//   jbrpc.org            -> JBRPC_SEAL+copy+birds.png
const SITE_LOGO_HOSTS = /(^|\.)(eatrippers\.com|tapthatrbny\.com|connollysrbny\.com|jbrpc\.org)$/i;

// A filename that announces itself as branding. Deliberately narrow: whole
// words only, so "iconic-sunset.jpg" and "sealife.jpg" are left alone.
const LOGO_FILENAME =
  /(^|[^a-z0-9])(logo|logos|logotype|wordmark|brandmark|seal|crest|favicon|sprite|watermark|placeholder)([^a-z0-9]|$)/i;

// True when a candidate URL looks like a logo rather than a photo.
function looksLikeLogo(u) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(u).pathname);
  } catch (e) {
    pathname = String(u);
  }
  const file = pathname.split("/").pop() || "";
  return LOGO_FILENAME.test(file);
}

/* ---- small helpers ----------------------------------------------------- */

function hostOf(u) {
  try {
    return new URL(String(u)).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

const isInstagramLink = (u) => SKIP_HOSTS.test(hostOf(u));

function timedFetch(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, Object.assign({ redirect: "follow" }, opts, { signal: ac.signal })).finally(
    () => clearTimeout(timer)
  );
}

// Drop a response body we are not going to read, so the socket is released.
function discard(res) {
  try {
    if (res && res.body && typeof res.body.cancel === "function") res.body.cancel();
  } catch (e) {
    /* already consumed */
  }
}

// Read at most maxBytes of a response body and decode it as text. A page that
// puts its og tags after 200 KB of inline script simply does not get enriched;
// that is a better trade than pulling multi-megabyte pages in a function.
async function readCapped(res, maxBytes, encoding) {
  const enc = encoding === "latin1" ? "latin1" : "utf8";
  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, maxBytes).toString(enc);
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const b = Buffer.from(value);
      chunks.push(b);
      total += b.length;
      if (total >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      /* stream already closed */
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString(enc);
}

// Just enough entity decoding for a URL sitting in an HTML attribute.
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch (e) {
    return "";
  }
}

// Read one attribute off a single tag string, quoted or bare, any order.
function attr(tag, name) {
  const re = new RegExp(
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))",
    "i"
  );
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

/* ---- parsing ----------------------------------------------------------- */

// Ranked list of image URLs advertised by a page, best first, already
// absolutised against pageUrl and filtered down to plausible http(s) images.
function extractImageCandidates(html, pageUrl) {
  const head = String(html || "");
  const ranked = [];

  const push = (rank, raw) => {
    const abs = absolutise(raw, pageUrl);
    // A site's logo is not a picture of the event, and stretched across a 4:5
    // card it looks worse than the category photo it would displace.
    if (abs && !looksLikeLogo(abs)) ranked.push({ rank, url: abs });
  };

  // <meta property="og:image" content="..."> and friends. Attribute order is
  // not guaranteed, so every meta tag is read rather than pattern-matched whole.
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(head)) !== null) {
    const tag = m[0];
    const key = String(attr(tag, "property") || attr(tag, "name") || "").toLowerCase().trim();
    if (!key) continue;
    const rank = META_RANK[key];
    if (rank === undefined) continue;
    push(rank, attr(tag, "content"));
  }

  // <link rel="image_src" href="..."> (and the apple-touch-icon style siblings
  // are deliberately NOT used: an icon is not a photo).
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(head)) !== null) {
    const tag = m[0];
    const rel = String(attr(tag, "rel") || "").toLowerCase().trim();
    if (rel !== "image_src") continue;
    push(90, attr(tag, "href"));
  }

  ranked.sort((a, b) => a.rank - b.rank);
  const seen = new Set();
  const out = [];
  for (const c of ranked) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c.url);
  }
  return out;
}

// Lower wins. secure_url first because it is the https twin of og:image.
const META_RANK = {
  "og:image:secure_url": 10,
  "og:image": 20,
  "og:image:url": 30,
  "twitter:image": 40,
  "twitter:image:src": 50,
  "twitter:image0": 60,
  "og:image0": 70,
};

// Turn whatever the tag held into an absolute http(s) URL, or null.
function absolutise(raw, pageUrl) {
  const s = decodeEntities(raw);
  if (!s) return null;
  if (/^data:/i.test(s)) return null; // inline blobs are never worth storing
  if (/^(javascript|about|mailto|tel|blob):/i.test(s)) return null;
  let u;
  try {
    u = new URL(s, pageUrl);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Never persist a signed Instagram/Facebook CDN URL: it expires in days.
  if (SKIP_HOSTS.test(u.hostname.toLowerCase())) return null;
  u.hash = "";
  return u.toString();
}

/* ---- network steps ----------------------------------------------------- */

// Fetch an event page and return its ranked image candidates.
async function candidatesFor(pageUrl) {
  const res = await timedFetch(pageUrl, { headers: PAGE_HEADERS }, PAGE_TIMEOUT_MS);
  const ct = String(res.headers.get("content-type") || "").toLowerCase();

  // The "URL" column sometimes points straight at a flyer image.
  if (/^image\//.test(ct)) {
    discard(res);
    if (/svg/.test(ct)) return [];
    const direct = absolutise(res.url || pageUrl, pageUrl);
    return direct ? [direct] : [];
  }
  if (!res.ok) {
    discard(res);
    throw new Error("HTTP " + res.status);
  }
  if (ct && !/(html|xml|text\/plain)/.test(ct)) {
    discard(res);
    return [];
  }
  const latin = /charset\s*=\s*"?(iso-8859-1|windows-1252|latin1)/i.test(ct);
  const html = await readCapped(res, MAX_HTML_BYTES, latin ? "latin1" : "utf8");
  // Redirects are followed, so candidates must resolve against where we landed.
  return extractImageCandidates(html, res.url || pageUrl);
}

// Confirm a candidate is a real, non-trivial, non-SVG image before storing it.
async function looksLikeImage(url) {
  let res = null;
  try {
    res = await timedFetch(url, { method: "HEAD", headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8" } }, HEAD_TIMEOUT_MS);
    discard(res);
  } catch (e) {
    res = null;
  }
  // Plenty of CDNs answer HEAD with 405 or 403. A tiny ranged GET is the
  // fallback and costs a couple of kilobytes.
  if (!res || !res.ok) {
    try {
      res = await timedFetch(
        url,
        {
          method: "GET",
          headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8", Range: "bytes=0-2047" },
        },
        HEAD_TIMEOUT_MS
      );
    } catch (e) {
      return false;
    } finally {
      /* body cancelled below */
    }
    discard(res);
    if (!res.ok) return false;
  }

  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  if (!/^image\//.test(ct)) return false;
  if (/svg/.test(ct)) return false; // an SVG here is a logo, not an event photo

  // content-range wins over content-length on a ranged GET, where
  // content-length describes the slice rather than the file.
  const cr = String(res.headers.get("content-range") || "");
  const totalFromRange = /\/(\d+)\s*$/.exec(cr);
  const size = totalFromRange
    ? Number(totalFromRange[1])
    : Number(res.headers.get("content-length"));
  if (Number.isFinite(size) && size > 0 && size < MIN_IMAGE_BYTES) return false;
  return true;
}

// The whole per-row job: pick a link, scrape it, validate, report a verdict.
// Returns { status, image?, reason? } and never throws.
async function resolveImage(row) {
  const link = row.url || row.instagram || null;
  if (!link) return { status: "nolink" };
  if (isInstagramLink(link)) return { status: "skipped", reason: "instagram" };
  if (SITE_LOGO_HOSTS.test(hostOf(link))) {
    // Sentinel, not "skipped": there is nothing to come back for, and the
    // frontend fallback is the better picture anyway.
    return { status: "none", reason: "site-wide logo og:image" };
  }

  let candidates;
  try {
    candidates = await candidatesFor(link);
  } catch (e) {
    return { status: "error", reason: shortErr(e) };
  }
  if (!candidates.length) return { status: "none", reason: "no og:image" };

  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    let ok = false;
    try {
      ok = await looksLikeImage(c);
    } catch (e) {
      ok = false;
    }
    if (ok) return { status: "updated", image: c };
  }
  return { status: "none", reason: "candidates failed validation" };
}

function shortErr(e) {
  const s = String((e && e.message) || e);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

/* ---- Notion side ------------------------------------------------------- */

// Rows in the curated DB that are still live and still have no Image.
// Recurring series often carry a start Date in the past, so they get their own
// OR branches rather than being caught by the date test.
function newDbCandidateFilter(today) {
  return {
    and: [
      { property: "Status", select: { equals: "Approved" } },
      { property: "Image", url: { is_empty: true } },
      {
        or: [
          { property: "Date", date: { on_or_after: today } },
          { property: "Date", date: { is_empty: true } },
          { property: "End Date", date: { on_or_after: today } },
          { property: "Recurring", select: { equals: "Weekly" } },
          { property: "Recurring", select: { equals: "Monthly" } },
        ],
      },
    ],
  };
}

// Same window the public feed uses for the legacy DB, plus "no Image yet".
// Notion only nests filters two deep, so the shared conditions are repeated
// inside both OR branches.
function legacyDbCandidateFilter(today) {
  const common = [
    { property: "Neighborhood", select: { equals: "Rockaway" } },
    { property: "Status", select: { does_not_equal: "Skip" } },
    { property: "Image", url: { is_empty: true } },
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
      { and: [...common, { property: "End Date", date: { on_or_after: today } }] },
    ],
  };
}

// Only the handful of fields this job needs, from either schema.
function candidateOf(page, db) {
  return {
    db,
    id: page.id,
    title: N.getTitle(page, "Event"),
    date: N.getDate(page, "Date"),
    url: N.getUrl(page, "URL"),
    // Only the curated DB has an Instagram column; getUrl tolerates its absence.
    instagram: db === "new" ? N.getUrl(page, "Instagram") : null,
  };
}

/* ---- the run ----------------------------------------------------------- */

async function runEnrichment(opts) {
  const o = opts || {};
  const token = o.token || process.env.NOTION_TOKEN;
  if (!token) {
    const err = new Error("Server not configured: NOTION_TOKEN is missing.");
    err.code = "NO_TOKEN";
    throw err;
  }
  const today = o.today || N.todayET();
  const limit = Math.max(1, Math.min(200, Number(o.limit) || MAX_ROWS));
  const dry = !!o.dry;
  const deadline =
    Date.now() + (Number(o.budgetMs) || (o.scheduled ? BUDGET_SCHEDULED_MS : BUDGET_MANUAL_MS));

  const warnings = [];
  const [newRes, legacyRes] = await Promise.allSettled([
    N.queryAll(
      N.NEW_DB_ID,
      {
        filter: newDbCandidateFilter(today),
        sorts: [{ property: "Date", direction: "ascending" }],
      },
      token
    ),
    N.queryAll(
      N.LEGACY_DB_ID,
      {
        filter: legacyDbCandidateFilter(today),
        sorts: [{ property: "Date", direction: "ascending" }],
      },
      token
    ),
  ]);

  const rows = [];
  if (newRes.status === "fulfilled") {
    for (const p of newRes.value) rows.push(candidateOf(p, "new"));
  } else {
    warnings.push("curated database unavailable: " + shortErr(newRes.reason));
  }
  if (legacyRes.status === "fulfilled") {
    for (const p of legacyRes.value) rows.push(candidateOf(p, "legacy"));
  } else {
    warnings.push("routine database unavailable: " + shortErr(legacyRes.reason));
  }
  if (newRes.status === "rejected" && legacyRes.status === "rejected") {
    const err = new Error("Both Notion databases failed");
    err.code = "BOTH_FAILED";
    err.detail = warnings.join(" | ");
    throw err;
  }

  // A row with nothing to scrape is not a candidate at all: it must not eat
  // one of the run's slots, and it must not be sentinelled either, because a
  // link could be added to it tomorrow.
  const noLink = rows.filter((r) => !r.url && !r.instagram).length;
  const linked = rows.filter((r) => r.url || r.instagram);

  // Oldest event first, undated rows last.
  linked.sort((a, b) => String(a.date || "9999").localeCompare(String(b.date || "9999")));
  const batch = linked.slice(0, limit);

  const summary = {
    scanned: 0,
    updated: 0,
    none: 0,
    skipped: 0,
    errors: 0,
    candidates: linked.length,
    noLink,
    truncated: false,
    dryRun: dry,
  };
  const details = [];

  let cursor = 0;
  async function worker() {
    for (;;) {
      if (Date.now() > deadline) {
        summary.truncated = true;
        return;
      }
      const i = cursor++;
      if (i >= batch.length) return;
      const row = batch[i];
      summary.scanned += 1;

      const verdict = await resolveImage(row);
      let write = null;
      if (verdict.status === "updated") write = verdict.image;
      else if (verdict.status === "none") write = IMAGE_NONE;
      // "skipped" (Instagram) and "nolink" deliberately write nothing, so a
      // later pass can still fill them in.

      if (write && !dry) {
        try {
          await N.updatePage(row.id, { Image: N.write.url(write) }, token);
        } catch (e) {
          summary.errors += 1;
          details.push({ id: row.id, title: row.title, status: "error", reason: "notion: " + shortErr(e) });
          continue;
        }
      }

      if (verdict.status === "updated") summary.updated += 1;
      else if (verdict.status === "none") summary.none += 1;
      else if (verdict.status === "skipped") summary.skipped += 1;
      else if (verdict.status === "error") summary.errors += 1;

      details.push({
        id: row.id,
        db: row.db,
        title: row.title,
        link: row.url || row.instagram || null,
        status: verdict.status,
        image: verdict.image || null,
        reason: verdict.reason || null,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, batch.length || 1) }, worker));

  if (summary.truncated) {
    warnings.push("time budget reached, " + (batch.length - summary.scanned) + " rows left for the next run");
  }
  const payload = Object.assign({ ran: new Date().toISOString(), today }, summary, { details });
  if (warnings.length) payload.warnings = warnings;
  return payload;
}

/* ---- handler ----------------------------------------------------------- */

// Netlify's scheduler POSTs {"next_run": "..."} and sends no query string.
// Anything else has to present the moderation key.
function isScheduledInvocation(event) {
  const qs = (event && event.queryStringParameters) || {};
  if (qs.key) return false;
  let body = (event && event.body) || "";
  if (event && event.isBase64Encoded) {
    try {
      body = Buffer.from(body, "base64").toString("utf8");
    } catch (e) {
      body = "";
    }
  }
  return /"?next_run"?/.test(String(body));
}

exports.handler = async (event) => {
  const ev = event || {};
  const qs = ev.queryStringParameters || {};
  const scheduled = isScheduledInvocation(ev);

  if (!scheduled) {
    const denied = requireKey(qs.key);
    if (denied) return denied;
  }

  const started = Date.now();
  try {
    const result = await runEnrichment({
      scheduled: scheduled,
      limit: qs.limit,
      dry: qs.dry === "1" || qs.dry === "true",
      budgetMs: qs.budgetMs ? Number(qs.budgetMs) : undefined,
    });
    result.ms = Date.now() - started;
    result.invocation = scheduled ? "scheduled" : "manual";
    // One line in the function log is what Jamal will actually read.
    console.log(
      "enrich-images " +
        result.invocation +
        " " +
        JSON.stringify({
          scanned: result.scanned,
          updated: result.updated,
          none: result.none,
          skipped: result.skipped,
          errors: result.errors,
          truncated: result.truncated,
          ms: result.ms,
        })
    );
    return json(200, result);
  } catch (e) {
    console.error("enrich-images failed:", e);
    const status = e && e.code === "NO_TOKEN" ? 500 : 502;
    return json(status, { error: shortErr(e), code: (e && e.code) || null });
  }
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  },
  body: JSON.stringify(obj),
});

module.exports.runEnrichment = runEnrichment;
module.exports.extractImageCandidates = extractImageCandidates;
module.exports.absolutise = absolutise;
module.exports.decodeEntities = decodeEntities;
module.exports.attr = attr;
module.exports.candidatesFor = candidatesFor;
module.exports.looksLikeImage = looksLikeImage;
module.exports.resolveImage = resolveImage;
module.exports.isScheduledInvocation = isScheduledInvocation;
module.exports.isInstagramLink = isInstagramLink;
module.exports.looksLikeLogo = looksLikeLogo;
module.exports.SITE_LOGO_HOSTS = SITE_LOGO_HOSTS;
module.exports.newDbCandidateFilter = newDbCandidateFilter;
module.exports.legacyDbCandidateFilter = legacyDbCandidateFilter;
module.exports.IMAGE_NONE = IMAGE_NONE;
module.exports.cleanImage = cleanImage;
