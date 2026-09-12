#!/usr/bin/env node
/*
 * scripts/save-venue-photo.js
 *
 *   node scripts/save-venue-photo.js <image-url-or-local-file> <slug> [--force]
 *
 * Saves one photograph of a real Rockaway venue into dist/img/venues/<slug>.jpg
 * and prints the public URL.
 *
 * Why this exists: dist/img/fallback/ is 20 stock photos and none of them is a
 * picture of an actual place here, so two different bars ended up wearing the
 * same stock bar interior. This folder is the opposite: every file is a
 * photograph of the venue it is named after, sourced from that venue's own
 * Instagram post or its own website, and dist/index.html maps venues and event
 * titles straight at them. Provenance for every file is in
 * dist/img/venues/CREDITS.md, which is not optional: a photo whose source we
 * cannot name does not belong here.
 *
 * The source can be a local file or an http(s) URL. Instagram CDN URLs are fine
 * as a SOURCE (the bytes are copied here immediately); they are never stored,
 * because the signed URLs expire within days.
 *
 * Output: max 1200 px on the long edge, JPEG quality 80, progressive, metadata
 * stripped. sharp comes from ../Wedding/node_modules, same as rasterize.js and
 * save-ig-image.js, so this repo still has zero dependencies of its own.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "img", "venues");
const PUBLIC_BASE = "https://rockawayevents.org/img/venues/";
const MAX_EDGE = 1200;
const QUALITY = 80;

let sharp;
try {
  sharp = require(path.resolve(ROOT, "..", "Wedding", "node_modules", "sharp"));
} catch (err) {
  console.error("Could not load sharp from ../Wedding/node_modules: " + err.message);
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function fetchBytes(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
    redirect: "follow",
  });
  if (!res.ok) die("HTTP " + res.status + " fetching " + url.slice(0, 120));
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--force");
  const force = process.argv.includes("--force");
  const [src, slug] = args;
  if (!src || !slug) die("usage: save-venue-photo.js <url-or-file> <slug> [--force]");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) die("slug must be lowercase kebab-case: " + slug);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, slug + ".jpg");
  if (fs.existsSync(out) && !force) die(slug + ".jpg already exists, pass --force to replace it");

  const input = /^https?:\/\//i.test(src) ? await fetchBytes(src) : fs.readFileSync(src);

  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) die("not an image");
  if (Math.max(meta.width, meta.height) < 600) {
    die("source is only " + meta.width + "x" + meta.height + ", too small to use");
  }

  await sharp(input)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
    .toFile(out);

  const after = await sharp(out).metadata();
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(
    slug + ".jpg  " + after.width + "x" + after.height + "  " + kb + " KB  <- " +
      meta.width + "x" + meta.height
  );
  console.log(PUBLIC_BASE + slug + ".jpg");
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
