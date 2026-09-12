#!/usr/bin/env node
/*
 * scripts/save-ig-image.js
 *
 *   node scripts/save-ig-image.js <image-url-or-local-file> <postcode> [--force]
 *
 * Copies one Instagram post photo into the site's own assets and prints the
 * public URL to paste into the Notion Image column.
 *
 * Why this exists: Instagram serves post photos from signed
 * scontent-*.cdninstagram.com / *.fbcdn.net URLs that expire within days and
 * refuse hotlinking, so a card pointing at one looks fine on Monday and is
 * broken by Thursday. netlify/functions/enrich-images.js therefore never writes
 * an Instagram URL into Notion at all; the daily local Instagram scan runs this
 * instead, commits dist/img/ig/<postcode>.jpg, and sets
 *   Image = https://rockawayevents.org/img/ig/<postcode>.jpg
 *
 * The source can be:
 *   - a file already on disk (what the browser-driven scan usually has), or
 *   - an http(s) URL, including a still-fresh Instagram CDN URL.
 *
 * Output: max 1200 px wide, JPEG quality 80, progressive, metadata stripped.
 *
 * sharp comes from ../Wedding/node_modules, same as scripts/rasterize.js, so
 * this repo still has zero dependencies of its own.
 *
 * Examples:
 *   node scripts/save-ig-image.js ./tmp/post.jpg DQ1a2B3cD4e
 *   node scripts/save-ig-image.js "https://scontent.cdninstagram.com/v/..." \
 *        "https://www.instagram.com/p/DQ1a2B3cD4e/"
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "img", "ig");
const PUBLIC_BASE = "https://rockawayevents.org/img/ig/";
const MAX_WIDTH = 1200;
const QUALITY = 80;
const FETCH_TIMEOUT_MS = 20000;

let sharp;
try {
  sharp = require(path.join(ROOT, "..", "Wedding", "node_modules", "sharp"));
} catch (e) {
  fail(
    "Could not load sharp from ../Wedding/node_modules/sharp.\n" +
      "This repo has no node_modules of its own on purpose; scripts/rasterize.js\n" +
      "borrows the same copy. Original error: " + e.message
  );
}

/* ---- args -------------------------------------------------------------- */

const argv = process.argv.slice(2).filter((a) => a !== "--force");
const force = process.argv.includes("--force");
const [source, rawCode] = argv;

if (!source || !rawCode) {
  fail(
    "usage: node scripts/save-ig-image.js <image-url-or-local-file> <postcode> [--force]\n" +
      "  <postcode> may be the bare shortcode (DQ1a2B3cD4e) or the full post URL."
  );
}

const code = shortcodeOf(rawCode);
if (!code) {
  fail(
    'Could not read an Instagram shortcode out of "' + rawCode + '".\n' +
      "Expected something like DQ1a2B3cD4e or https://www.instagram.com/p/DQ1a2B3cD4e/"
  );
}

/* ---- helpers ----------------------------------------------------------- */

function fail(msg) {
  process.stderr.write(String(msg) + "\n");
  process.exit(1);
}

// Instagram shortcodes are [A-Za-z0-9_-], 5 to 30 chars. Accept the bare code
// or pull it out of /p/, /reel/ or /tv/ URLs. Anything else is rejected rather
// than sanitised, so a stray path fragment can never write outside OUT_DIR.
function shortcodeOf(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const fromUrl = /(?:^|\/)(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,30})/.exec(s);
  const candidate = fromUrl ? fromUrl[1] : s.replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_-]{5,30}$/.test(candidate) ? candidate : null;
}

async function readSource(src) {
  if (/^https?:\/\//i.test(src)) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(src, {
        signal: ac.signal,
        redirect: "follow",
        headers: {
          // Instagram's CDN is much friendlier to a browser-shaped request
          // that says it came from instagram.com.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: "https://www.instagram.com/",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + src);
    const ct = String(res.headers.get("content-type") || "");
    if (ct && !/^image\//i.test(ct)) {
      throw new Error(
        "That URL returned " + ct + ", not an image. Signed Instagram URLs expire, " +
          "so re-copy the image address from the post and try again."
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }
  const abs = path.resolve(process.cwd(), src);
  if (!fs.existsSync(abs)) throw new Error("No such file: " + abs);
  return fs.readFileSync(abs);
}

/* ---- main -------------------------------------------------------------- */

(async () => {
  const outPath = path.join(OUT_DIR, code + ".jpg");
  if (fs.existsSync(outPath) && !force) {
    process.stdout.write(
      PUBLIC_BASE + code + ".jpg\n" +
        "(already saved; pass --force to overwrite)\n"
    );
    return;
  }

  const input = await readSource(source);
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error("Not a decodable image.");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const info = await sharp(input)
    .rotate() // honour EXIF orientation before it is stripped
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
    .toFile(outPath);

  process.stdout.write(
    PUBLIC_BASE + code + ".jpg\n" +
      "  wrote " + path.relative(ROOT, outPath).replace(/\\/g, "/") +
      "  " + info.width + "x" + info.height +
      "  " + Math.round(info.size / 1024) + " KB" +
      "  (from " + meta.width + "x" + meta.height + " " + meta.format + ")\n" +
      "  Set the Notion Image property to the URL above, then commit and deploy.\n"
  );
})().catch((e) => fail("save-ig-image failed: " + (e && e.message ? e.message : e)));
