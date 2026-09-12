#!/usr/bin/env node
/*
 * scripts/test-enrich-images.js
 *
 *   node scripts/test-enrich-images.js          # offline only, no network
 *   node scripts/test-enrich-images.js --live   # also fetch real event pages
 *   node scripts/test-enrich-images.js --live <url> [<url> ...]
 *
 * Three layers:
 *   1. parser unit tests  - extractImageCandidates / absolutise / decodeEntities
 *      against hand-written HTML covering the shapes real pages use.
 *   2. an end-to-end run  - runEnrichment() driven by a stubbed global.fetch
 *      that plays both Notion and the open web, so the Notion writes, the
 *      IMAGE_NONE sentinel, the Instagram skip and the error paths are all
 *      exercised without a token.
 *   3. --live             - the same code against real pages, printing which
 *      ones actually yield an image. Nothing is written to Notion.
 *
 * Exit code is non-zero if any offline assertion fails. --live never fails the
 * run: a site being down is news, not a bug in this repo.
 */

"use strict";

const path = require("path");
const FN = path.resolve(__dirname, "..", "netlify", "functions", "enrich-images.js");
const E = require(FN);
const { IMAGE_NONE } = E;

let passed = 0;
let failed = 0;

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log("  ok    " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label + "\n          got      " + a + "\n          expected " + b);
  }
}

/* ========================================================================= */
/* 1. parser                                                                 */
/* ========================================================================= */

function parserTests() {
  console.log("\n[1] parser");
  const P = "https://example.org/events/beach-party/";
  const first = (html, base) => E.extractImageCandidates(html, base || P)[0] || null;

  eq(
    "plain og:image",
    first('<meta property="og:image" content="https://cdn.example.org/a.jpg">'),
    "https://cdn.example.org/a.jpg"
  );

  eq(
    "og:image:secure_url outranks og:image",
    first(
      '<meta property="og:image" content="http://cdn.example.org/insecure.jpg">' +
        '<meta property="og:image:secure_url" content="https://cdn.example.org/secure.jpg">'
    ),
    "https://cdn.example.org/secure.jpg"
  );

  eq(
    "content before property (attribute order must not matter)",
    first('<meta content="https://cdn.example.org/b.jpg" property="og:image" />'),
    "https://cdn.example.org/b.jpg"
  );

  eq(
    "single quotes and name= instead of property=",
    first("<meta name='og:image' content='https://cdn.example.org/c.jpg'>"),
    "https://cdn.example.org/c.jpg"
  );

  eq(
    "root-relative URL resolves against the page",
    first('<meta property="og:image" content="/uploads/flyer.png">'),
    "https://example.org/uploads/flyer.png"
  );

  eq(
    "document-relative URL resolves against the page directory",
    first('<meta property="og:image" content="flyer.png">'),
    "https://example.org/events/beach-party/flyer.png"
  );

  eq(
    "protocol-relative URL takes the page scheme",
    first('<meta property="og:image" content="//cdn.example.org/d.jpg">'),
    "https://cdn.example.org/d.jpg"
  );

  eq(
    "HTML entities in the query string are decoded",
    first('<meta property="og:image" content="https://cdn.example.org/e.jpg?w=1&amp;h=2&amp;fit=crop">'),
    "https://cdn.example.org/e.jpg?w=1&h=2&fit=crop"
  );

  eq(
    "numeric entities are decoded",
    first('<meta property="og:image" content="https://cdn.example.org/f.jpg?a=1&#38;b=2&#x26;c=3">'),
    "https://cdn.example.org/f.jpg?a=1&b=2&c=3"
  );

  eq("data: URI is rejected", first('<meta property="og:image" content="data:image/png;base64,iVBORw0KGgo=">'), null);
  eq("javascript: URI is rejected", first('<meta property="og:image" content="javascript:alert(1)">'), null);
  eq("empty content is rejected", first('<meta property="og:image" content="">'), null);
  eq("ftp: is rejected", first('<meta property="og:image" content="ftp://example.org/x.jpg">'), null);

  eq(
    "Instagram CDN og:image is rejected (signed URL, expires in days)",
    first('<meta property="og:image" content="https://scontent-lga3-1.cdninstagram.com/v/t51.29350-15/x.jpg?_nc_ht=y">'),
    null
  );
  eq(
    "Facebook CDN og:image is rejected",
    first('<meta property="og:image" content="https://z-p3-scontent.xx.fbcdn.net/v/t39/x.jpg">'),
    null
  );

  eq(
    "twitter:image is used when there is no og:image",
    first('<meta name="twitter:image" content="https://cdn.example.org/tw.jpg">'),
    "https://cdn.example.org/tw.jpg"
  );
  eq(
    "og:image still beats twitter:image",
    first(
      '<meta name="twitter:image" content="https://cdn.example.org/tw.jpg">' +
        '<meta property="og:image" content="https://cdn.example.org/og.jpg">'
    ),
    "https://cdn.example.org/og.jpg"
  );

  eq(
    "link rel=image_src is the last resort",
    first('<link rel="image_src" href="https://cdn.example.org/legacy.jpg">'),
    "https://cdn.example.org/legacy.jpg"
  );
  eq(
    "an apple-touch-icon is never treated as a photo",
    first('<link rel="apple-touch-icon" href="https://cdn.example.org/icon.png">'),
    null
  );

  eq(
    "duplicate candidates collapse, order preserved",
    E.extractImageCandidates(
      '<meta property="og:image" content="https://cdn.example.org/a.jpg">' +
        '<meta name="twitter:image" content="https://cdn.example.org/a.jpg">' +
        '<meta name="twitter:image:src" content="https://cdn.example.org/b.jpg">',
      P
    ),
    ["https://cdn.example.org/a.jpg", "https://cdn.example.org/b.jpg"]
  );

  eq("no tags at all", E.extractImageCandidates("<html><body>hi</body></html>", P), []);

  // A real Eventbrite head, trimmed: several og tags, entities, an absolute CDN URL.
  eq(
    "eventbrite-shaped head",
    first(
      '<html><head><title>Thing</title>' +
        '<meta property="og:type" content="event">' +
        '<meta property="og:title" content="Beach Party">' +
        '<meta property="og:image" content="https://img.evbuc.com/https%3A%2F%2Fcdn.evbuc.com%2Fimages%2F1.jpg?w=940&amp;auto=format">' +
        '<meta name="twitter:image" content="https://img.evbuc.com/other.jpg">' +
        "</head>"
    ),
    "https://img.evbuc.com/https%3A%2F%2Fcdn.evbuc.com%2Fimages%2F1.jpg?w=940&auto=format"
  );

  eq("decodeEntities leaves a clean URL alone", E.decodeEntities("https://a.b/c?d=1"), "https://a.b/c?d=1");
  eq("attr reads a bare unquoted value", E.attr("<meta property=og:image content=https://a.b/c.jpg>", "content"), "https://a.b/c.jpg");

  console.log("\n[1a] logos are not photos");
  eq("og:image that is a logo file is dropped", first('<meta property="og:image" content="https://x.example/Rippers_Vector_Logo_g.png?format=1500w">'), null);
  eq("wordmark is dropped", first('<meta property="og:image" content="https://x.example/site-wordmark.png">'), null);
  eq("a club seal is dropped", first('<meta property="og:image" content="https://x.example/JBRPC_SEAL+copy+birds.png">'), null);
  eq("favicon is dropped", first('<meta property="og:image" content="https://x.example/favicon-512.png">'), null);
  eq("but iconic-sunset.jpg is kept", first('<meta property="og:image" content="https://x.example/iconic-sunset.jpg">'), "https://x.example/iconic-sunset.jpg");
  eq("and sealife.jpg is kept", first('<meta property="og:image" content="https://x.example/sealife.jpg">'), "https://x.example/sealife.jpg");
  eq("and a path folder named logos does not condemn the file", first('<meta property="og:image" content="https://x.example/logos/beach-party-flyer.jpg">'), "https://x.example/logos/beach-party-flyer.jpg");
  eq("the next candidate is used when the first is a logo", first('<meta property="og:image" content="https://x.example/logo.png"><meta name="twitter:image" content="https://x.example/crowd.jpg">'), "https://x.example/crowd.jpg");
  eq("looksLikeLogo direct", [E.looksLikeLogo("https://a.b/logo.png"), E.looksLikeLogo("https://a.b/seals-at-riis.jpg")], [true, false]);
  eq("site-wide-logo hosts are recognised", [E.SITE_LOGO_HOSTS.test("www.eatrippers.com"), E.SITE_LOGO_HOSTS.test("jbrpc.org"), E.SITE_LOGO_HOSTS.test("rockawaytimes.com"), E.SITE_LOGO_HOSTS.test("therockawayhotel.com")], [true, true, true, false]);

  console.log("\n[1b] instagram link detection");
  for (const u of [
    "https://www.instagram.com/p/ABC123/",
    "https://instagram.com/rockawaytrainer",
    "https://m.instagram.com/p/ABC123/",
    "https://instagr.am/p/ABC123/",
  ]) {
    eq("skip " + u, E.isInstagramLink(u), true);
  }
  for (const u of ["https://www.eatrippers.com/", "https://myinstagram.example.com/p/x"]) {
    eq("scrape " + u, E.isInstagramLink(u), false);
  }

  console.log("\n[1c] scheduled-invocation detection");
  eq("Netlify schedule body", E.isScheduledInvocation({ body: '{"next_run":"2026-09-13T08:20:00.000Z"}' }), true);
  eq("base64 schedule body", E.isScheduledInvocation({ isBase64Encoded: true, body: Buffer.from('{"next_run":"x"}').toString("base64") }), true);
  eq("manual call with a key is not scheduled", E.isScheduledInvocation({ queryStringParameters: { key: "k" }, body: '{"next_run":"x"}' }), false);
  eq("empty GET is not scheduled", E.isScheduledInvocation({ queryStringParameters: {}, body: null }), false);
  eq("some other POST is not scheduled", E.isScheduledInvocation({ body: '{"hello":"world"}' }), false);
}

/* ========================================================================= */
/* 2. end to end, on a stubbed fetch                                         */
/* ========================================================================= */

// Minimal Response-alikes. readCapped falls back to arrayBuffer() when there is
// no streaming body, which is exactly what we want here.
function htmlRes(url, body, ct) {
  return {
    ok: true,
    status: 200,
    url,
    headers: hdrs({ "content-type": ct || "text/html; charset=utf-8" }),
    arrayBuffer: async () => Buffer.from(body, "utf8"),
    text: async () => body,
  };
}
function imgRes(url, ct, len) {
  return {
    ok: true,
    status: 200,
    url,
    headers: hdrs({ "content-type": ct, "content-length": String(len) }),
    arrayBuffer: async () => Buffer.alloc(0),
  };
}
function errRes(url, status) {
  return { ok: false, status, url, headers: hdrs({}), arrayBuffer: async () => Buffer.alloc(0), text: async () => "" };
}
function jsonRes(obj) {
  return { ok: true, status: 200, url: "", headers: hdrs({ "content-type": "application/json" }), json: async () => obj };
}
function hdrs(map) {
  const m = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => (m.has(String(k).toLowerCase()) ? m.get(String(k).toLowerCase()) : null) };
}

function notionPage(id, props) {
  return { id, properties: props };
}
const pText = (s) => ({ rich_text: [{ plain_text: s }] });
const pTitle = (s) => ({ title: [{ plain_text: s }] });
const pUrl = (s) => ({ url: s });
const pDate = (s) => ({ date: s ? { start: s } : null });

async function e2eTests() {
  console.log("\n[2] end to end with a stubbed fetch");

  const NEW_ROWS = [
    notionPage("row-ok", {
      Event: pTitle("Live music at Connolly's"),
      Date: pDate("2026-09-14"),
      URL: pUrl("https://connollys.example/live"),
      Instagram: pUrl(null),
    }),
    notionPage("row-relative", {
      Event: pTitle("Surf lesson"),
      Date: pDate("2026-09-15"),
      URL: pUrl("https://surf.example/lessons/fall/"),
      Instagram: pUrl(null),
    }),
    notionPage("row-none", {
      Event: pTitle("Civic meeting"),
      Date: pDate("2026-09-16"),
      URL: pUrl("https://civic.example/meeting"),
      Instagram: pUrl(null),
    }),
    notionPage("row-ig", {
      Event: pTitle("Pop up from an Instagram post"),
      Date: pDate("2026-09-17"),
      URL: pUrl(null),
      Instagram: pUrl("https://www.instagram.com/p/DQ1a2B3cD4e/"),
    }),
    notionPage("row-404", {
      Event: pTitle("Dead link"),
      Date: pDate("2026-09-18"),
      URL: pUrl("https://gone.example/event"),
      Instagram: pUrl(null),
    }),
    notionPage("row-svg", {
      Event: pTitle("Logo only"),
      Date: pDate("2026-09-19"),
      URL: pUrl("https://logo.example/event"),
      Instagram: pUrl(null),
    }),
    notionPage("row-nolink", {
      Event: pTitle("No link at all"),
      Date: pDate("2026-09-20"),
      URL: pUrl(null),
      Instagram: pUrl(null),
    }),
    notionPage("row-sitelogo", {
      Event: pTitle("Rippers weekly"),
      Date: pDate("2026-09-22"),
      URL: pUrl("https://www.eatrippers.com/2026-summer-schedule"),
      Instagram: pUrl(null),
    }),
    notionPage("row-igcdn", {
      Event: pTitle("og:image points at Instagram's CDN"),
      Date: pDate("2026-09-21"),
      URL: pUrl("https://embeds.example/event"),
      Instagram: pUrl(null),
    }),
  ];
  const LEGACY_ROWS = [
    notionPage("legacy-ok", {
      Event: pTitle("⭐ Rockaway Hotel rooftop"),
      Date: pDate("2026-09-13"),
      URL: pUrl("https://hotel.example/whats-on"),
      Time: pText("7 PM"),
    }),
  ];

  const PAGES = {
    "https://connollys.example/live": htmlRes(
      "https://connollys.example/live",
      '<head><meta property="og:image" content="https://cdn.example/connollys.jpg?a=1&amp;b=2"></head>'
    ),
    "https://surf.example/lessons/fall/": htmlRes(
      "https://surf.example/lessons/fall/",
      '<head><meta property="og:image" content="../img/surf.jpg"></head>'
    ),
    "https://civic.example/meeting": htmlRes(
      "https://civic.example/meeting",
      "<head><title>Meeting</title></head><body>No pictures here.</body>"
    ),
    "https://logo.example/event": htmlRes(
      "https://logo.example/event",
      '<head><meta property="og:image" content="https://cdn.example/logo.svg"></head>'
    ),
    "https://embeds.example/event": htmlRes(
      "https://embeds.example/event",
      '<head><meta property="og:image" content="https://scontent-lga3-1.cdninstagram.com/v/t51/x.jpg?sig=1"></head>'
    ),
    "https://hotel.example/whats-on": htmlRes(
      "https://hotel.example/whats-on",
      '<head><meta content="https://cdn.example/hotel.jpg" property="og:image:secure_url"></head>'
    ),
  };
  const IMAGES = {
    "https://cdn.example/connollys.jpg?a=1&b=2": ["image/jpeg", 84000],
    "https://surf.example/lessons/img/surf.jpg": ["image/jpeg", 51000],
    "https://cdn.example/logo.svg": ["image/svg+xml", 2200],
    "https://cdn.example/hotel.jpg": ["image/jpeg", 120000],
  };

  const patched = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = ((opts && opts.method) || "GET").toUpperCase();

    if (u.includes("/databases/") && u.endsWith("/query")) {
      const isNew = u.includes("c83a031ec6644f04a21800790660c9d4");
      return jsonRes({ results: isNew ? NEW_ROWS : LEGACY_ROWS, has_more: false });
    }
    if (u.startsWith("https://api.notion.com/v1/pages/") && method === "PATCH") {
      patched.push({ id: u.split("/pages/")[1], body: JSON.parse(opts.body) });
      return jsonRes({ object: "page" });
    }
    if (u.startsWith("https://www.instagram.com") || u.includes("cdninstagram")) {
      throw new Error("the enricher must never fetch Instagram");
    }
    if (PAGES[u]) return PAGES[u];
    if (IMAGES[u]) {
      const [ct, len] = IMAGES[u];
      return imgRes(u, ct, len);
    }
    return errRes(u, 404);
  };

  let out;
  try {
    out = await E.runEnrichment({ token: "fake-token", today: "2026-09-12" });
  } finally {
    global.fetch = realFetch;
  }

  const byId = {};
  for (const d of out.details) byId[d.id] = d;
  const written = {};
  for (const p of patched) written[p.id] = p.body.properties.Image.url;

  eq("row with a good og:image is updated", byId["row-ok"].status, "updated");
  eq("  and the entity-decoded URL is written", written["row-ok"], "https://cdn.example/connollys.jpg?a=1&b=2");
  eq("relative og:image resolves against the page dir", written["row-relative"], "https://surf.example/lessons/img/surf.jpg");
  eq("page with no og:image gets the sentinel", written["row-none"], IMAGE_NONE);
  eq("  and is counted as none", byId["row-none"].status, "none");
  eq("Instagram row is skipped", byId["row-ig"].status, "skipped");
  eq("  and nothing is written for it", written["row-ig"], undefined);
  eq("404 page is an error", byId["row-404"].status, "error");
  eq("  and nothing is written for it", written["row-404"], undefined);
  eq("SVG og:image is refused, sentinel written", written["row-svg"], IMAGE_NONE);
  eq("Instagram CDN og:image is refused, sentinel written", written["row-igcdn"], IMAGE_NONE);
  eq("site-wide-logo host is sentinelled without a fetch", written["row-sitelogo"], IMAGE_NONE);
  eq("  and its reason says why", byId["row-sitelogo"].reason, "site-wide logo og:image");
  eq("row with no link at all is never a candidate", byId["row-nolink"], undefined);
  eq("  and is counted in noLink", out.noLink, 1);
  eq("legacy DB row is enriched too", written["legacy-ok"], "https://cdn.example/hotel.jpg");

  eq("summary counts", { scanned: out.scanned, updated: out.updated, none: out.none, skipped: out.skipped, errors: out.errors }, {
    scanned: 9,
    updated: 3,
    none: 4,
    skipped: 1,
    errors: 1,
  });
  eq("nothing was written twice", patched.length, 7);
  eq("not truncated", out.truncated, false);

  console.log("\n[2b] dry run writes nothing");
  const realFetch2 = global.fetch;
  const patched2 = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/databases/") && u.endsWith("/query")) {
      return jsonRes({ results: u.includes("c83a031") ? NEW_ROWS.slice(0, 1) : [], has_more: false });
    }
    if (u.startsWith("https://api.notion.com/v1/pages/")) {
      patched2.push(u);
      return jsonRes({});
    }
    if (PAGES[u]) return PAGES[u];
    if (IMAGES[u]) return imgRes(u, IMAGES[u][0], IMAGES[u][1]);
    return errRes(u, 404);
  };
  let dry;
  try {
    dry = await E.runEnrichment({ token: "fake-token", today: "2026-09-12", dry: true });
  } finally {
    global.fetch = realFetch2;
  }
  eq("dry run still resolves the image", dry.updated, 1);
  eq("dry run makes no Notion PATCH", patched2.length, 0);

  console.log("\n[2b2] oldest event first: a limit of 1 takes the earliest date");
  const realFetch3 = global.fetch;
  const patched3 = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/databases/") && u.endsWith("/query")) {
      return jsonRes({ results: u.includes("c83a031") ? NEW_ROWS : LEGACY_ROWS, has_more: false });
    }
    if (u.startsWith("https://api.notion.com/v1/pages/")) {
      patched3.push(u.split("/pages/")[1]);
      return jsonRes({});
    }
    if (PAGES[u]) return PAGES[u];
    if (IMAGES[u]) return imgRes(u, IMAGES[u][0], IMAGES[u][1]);
    return errRes(u, 404);
  };
  let one;
  try {
    one = await E.runEnrichment({ token: "fake-token", today: "2026-09-12", limit: 1 });
  } finally {
    global.fetch = realFetch3;
  }
  eq("only one row is touched", one.scanned, 1);
  eq("and it is the 2026-09-13 legacy row, not a later one", patched3, ["legacy-ok"]);
  eq("the rest are still reported as candidates", one.candidates, 9);

  console.log("\n[2c] the sentinel round-trips through events-core as null");
  const core = require(path.resolve(__dirname, "..", "netlify", "functions", "lib", "events-core.js"));
  eq("sentinel -> null", core.cleanImage(IMAGE_NONE), null);
  eq("cdninstagram -> null", core.cleanImage("https://scontent-lga3-1.cdninstagram.com/v/x.jpg"), null);
  eq("fbcdn -> null", core.cleanImage("https://z-p3.xx.fbcdn.net/v/x.jpg"), null);
  eq("our own saved IG still survives", core.cleanImage("https://rockawayevents.org/img/ig/ABC123.jpg"), "https://rockawayevents.org/img/ig/ABC123.jpg");
  eq(
    "legacy row now reads the Image column",
    core.legacyDbRow(notionPage("x", { Event: pTitle("T"), Date: pDate("2026-09-20"), Image: pUrl("https://cdn.example/legacy.jpg") })).image,
    "https://cdn.example/legacy.jpg"
  );
  eq(
    "legacy row with the sentinel reads as null",
    core.legacyDbRow(notionPage("x", { Event: pTitle("T"), Date: pDate("2026-09-20"), Image: pUrl(IMAGE_NONE) })).image,
    null
  );
}

/* ========================================================================= */
/* 3. live                                                                   */
/* ========================================================================= */

// Real pages of the kinds that actually appear in the feed. Nothing is written
// to Notion; this only reports what each page advertises.
const LIVE_DEFAULTS = [
  // An Eventbrite listing page: the shape most ticketed events arrive in.
  "https://www.eventbrite.com/d/ny--rockaway-beach/events/",
  // The Rockaway Hotel's real calendar URL, straight out of /api/events.
  "https://www.therockawayhotel.com/things-to-do-rockaway-beach/event-calendar",
  // Rockaway Theatre Company, a Wix site.
  "https://rockawaytc.org/",
  // A venue whose og:image is its own logo: must come back NO IMAGE now.
  "https://www.eatrippers.com/2026-summer-schedule",
  // A local paper's listings page, a plain WordPress install.
  "https://rockawaytimes.com/things-to-do-205/",
];

async function liveTests(urls) {
  console.log("\n[3] live pages (no Notion writes)");
  for (const url of urls) {
    const started = Date.now();
    let line;
    try {
      const cands = await E.candidatesFor(url);
      if (!cands.length) {
        line = "NO IMAGE   (page fetched, no og:image / twitter:image / image_src)";
      } else {
        let ok = null;
        for (const c of cands.slice(0, 4)) {
          if (await E.looksLikeImage(c)) {
            ok = c;
            break;
          }
        }
        line = ok
          ? "IMAGE      " + ok
          : "REJECTED   " + cands.length + " candidate(s), none validated as an image: " + cands[0];
      }
    } catch (e) {
      line = "ERROR      " + (e && e.message ? e.message : e);
    }
    console.log("  " + line + "\n    <- " + url + "  (" + (Date.now() - started) + " ms)");
  }
}

/* ========================================================================= */

(async () => {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const urls = args.filter((a) => /^https?:\/\//i.test(a));

  parserTests();
  await e2eTests();

  console.log("\n" + passed + " passed, " + failed + " failed");

  if (live) await liveTests(urls.length ? urls : LIVE_DEFAULTS);
  else console.log("\n(run with --live to also fetch real event pages)");

  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
