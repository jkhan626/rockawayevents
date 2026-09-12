#!/usr/bin/env node
/*
 * scripts/fetch-fallback-photos.js
 *
 *   node scripts/fetch-fallback-photos.js            # fetch anything missing
 *   node scripts/fetch-fallback-photos.js --force    # re-fetch everything
 *   node scripts/fetch-fallback-photos.js music surf-beach   # just these slots
 *
 * Downloads the Unsplash photos listed in PHOTOS below, crops each to 900x640,
 * squeezes it under the size budget, and writes dist/img/fallback/<slot>.jpg
 * plus dist/img/fallback/CREDITS.md.
 *
 * These are the pictures the site falls back to when an event has no image of
 * its own, which today is nearly every event: dist/index.html picks
 *   event.image  ->  VENUE_IMAGES match  ->  category photo  ->  rockaway.jpg
 *
 * NONE of these is a photograph of an actual Rockaway venue. The bar, library
 * and marsh shots are mood-matched stand-ins used where a venue has no freely
 * licensed photo, which is all of them. CREDITS.md says so out loud, because
 * captioning a stock bar as "Connolly's" would be a small lie on a page whose
 * whole job is telling people where to turn up.
 *
 * Unsplash License: free to use commercially, no permission needed, attribution
 * appreciated not required. We credit anyway, in CREDITS.md.
 *
 * sharp comes from ../Wedding/node_modules, same as the other scripts here, so
 * this repo keeps its zero dependencies.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "img", "fallback");

const WIDTH = 900;
const HEIGHT = 640; // ~1.4:1; crops cleanly to the card's 4:5 and the sheet's 16:9
const MAX_KB = 150;
const QUALITY_LADDER = [78, 72, 66, 60, 54];

let sharp;
try {
  sharp = require(path.join(ROOT, "..", "Wedding", "node_modules", "sharp"));
} catch (e) {
  console.error("Could not load sharp from ../Wedding/node_modules/sharp: " + e.message);
  process.exit(1);
}

/* ------------------------------------------------------------------------ *
 * The photo list.
 *
 * slot      file written as dist/img/fallback/<slot>.jpg, and the name the
 *           frontend refers to in CAT_IMAGES / VENUE_IMAGES
 * id        the Unsplash photo id, i.e. images.unsplash.com/photo-<id>
 * by        photographer, for CREDITS.md
 * page      the Unsplash page, for CREDITS.md
 * shows     what is actually in the frame
 * ------------------------------------------------------------------------ */

const PHOTOS = [
  // ---- one per Category in the Notion multi_select ----------------------
  { slot: "music", id: "1589553975453-d7e36c7cfbf8", by: "Uwe Conrad",
    page: "https://unsplash.com/photos/IKw7MRYwTK8",
    shows: "Silhouetted crowd at a night-time outdoor concert, stage lit behind them" },
  { slot: "food-drink", id: "1599974579688-8dbdd335c77f", by: "Jeswin Thomas",
    page: "https://unsplash.com/photos/z_PfaGzeN9E",
    shows: "Three beef tacos with onion and cilantro" },
  { slot: "run-fitness", id: "1590091733050-bcfa83453dbf", by: "Chris Hardy",
    page: "https://unsplash.com/photos/NEW_U9lp3Hw",
    shows: "A runner on an ocean boardwalk at twilight" },
  { slot: "surf-beach", id: "1517702669-ebedf5190943", by: "Ines Alvarez Fdez",
    page: "https://unsplash.com/photos/u6rZ2_bUgUE",
    shows: "Two surfers carrying boards down the sand toward the water" },
  { slot: "kids-family", id: "1531129630896-1744cab0cafd", by: "Vidar Nordli-Mathisen",
    page: "https://unsplash.com/photos/yxwBJjtgtUs",
    shows: "Two small children playing under a striped umbrella on a sandy beach" },
  { slot: "arts-culture", id: "1721808524566-a047e20664bb", by: "Patrick Federi",
    page: "https://unsplash.com/photos/38lpR0_vE0k",
    shows: "A large painted mural filling the side of a building" },
  { slot: "community", id: "1768244016517-2ec30e558a78", by: "Brian Kungu",
    page: "https://unsplash.com/photos/5OtFTXbjCrw",
    shows: "A group of people dancing together outdoors" },
  { slot: "market", id: "1687199129802-3e4cc27baac0", by: "Bovia and Co. Photography",
    page: "https://unsplash.com/photos/dIlK7zN4M6I",
    shows: "Carrots and mixed produce on a farmers market table" },
  { slot: "nightlife", id: "1720694924759-2a2daaa98987", by: "Panos Katsigiannis",
    page: "https://unsplash.com/photos/WK1Cf_A7nyY",
    shows: "A warmly lit bar interior, stools along the counter" },
  { slot: "volunteer", id: "1565803974275-dccd2f933cbb", by: "Brian Yurasits",
    page: "https://unsplash.com/photos/PzQNdXw2a6g",
    shows: "People picking up plastic litter during a beach cleanup" },
  { slot: "outdoors", id: "1773620430312-e78929f4b2bf", by: "Akshat Adsule",
    page: "https://unsplash.com/photos/YJZceqfyJUY",
    shows: "A white egret standing in tall salt-marsh grass" },
  { slot: "sports", id: "1634501087922-c01c76ed66d6", by: "Josh Duke",
    page: "https://unsplash.com/photos/UHBlHMByybU",
    shows: "A game of beach volleyball on a sunny day" },
  { slot: "other", id: "1439405326854-014607f694d7", by: "Joseph Barrientos",
    page: "https://unsplash.com/photos/oQl0eVYd_n8",
    shows: "Calm open ocean and horizon at golden hour" },

  // ---- the default every unmatched event lands on ------------------------
  // This is the picture most cards will show, so it gets the most attention:
  // warm wood, hard shadows, real depth. The first pick here was a pale,
  // flat-white-sky boardwalk that made the grid look exactly as blank as the
  // generated posters it replaced.
  { slot: "rockaway", id: "1648134915418-3ef7789c55c9", by: "Olivia Jane",
    page: "https://unsplash.com/photos/7201ioiPOjE",
    shows: "A wooden beach boardwalk with a railing running out toward the sand on a sunny day" },

  // ---- mood-matched stand-ins for venues with no free photo --------------
  { slot: "bar-patio", id: "1780387911357-1c932fdc0ffc", by: "jens schwan",
    page: "https://unsplash.com/photos/pcmnV_l_OPk",
    shows: "An outdoor cafe patio under a tree, bar stools along the counter" },
  { slot: "beach-bar", id: "1688612273073-5e2ad11278cf", by: "Adam Gilley",
    page: "https://unsplash.com/photos/gmU0h2X943g",
    shows: "A blue seaside seafood shack near the beach" },
  { slot: "library", id: "1651313745674-eb83846a1d85", by: "Andy Wang",
    page: "https://unsplash.com/photos/fvWUPOG99cY",
    shows: "A public library interior, rows of bookshelves" },
  { slot: "park-nature", id: "1781492783365-26a7bf611d5b", by: "Bryan White",
    page: "https://unsplash.com/photos/X4xvtEvFJNg",
    shows: "A heron standing still in a calm coastal lagoon" },
  { slot: "boardwalk-sunset", id: "1748550479740-cbcfd5b07fe3", by: "Yash Pai",
    page: "https://unsplash.com/photos/KFRoW1Q1mFg",
    shows: "A wooden pier reaching out over the ocean at sunset" },
  { slot: "community-center", id: "1515187029135-18ee286d815b", by: "Antenna",
    page: "https://unsplash.com/photos/cw-cj_nFa14",
    shows: "A group talking together at a workshop in a bright room" },
];

/* ---- fetch + squeeze --------------------------------------------------- */

// Ask Unsplash for more pixels than we keep, so the downscale does the
// anti-aliasing rather than the CDN's own resizer.
const sourceUrl = (id) =>
  "https://images.unsplash.com/photo-" + id + "?w=1600&q=85&fm=jpg&fit=max&auto=format";

async function download(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  const ct = String(res.headers.get("content-type") || "");
  if (!/^image\//i.test(ct)) throw new Error("content-type was " + (ct || "(none)"));
  return Buffer.from(await res.arrayBuffer());
}

// Crop to the card shape and step the quality down until it fits the budget.
// `attention` lets sharp keep the busiest part of the frame, which is usually
// the surfer or the band rather than an empty corner of sky.
async function squeeze(input) {
  let last = null;
  for (const quality of QUALITY_LADDER) {
    const buf = await sharp(input)
      .rotate()
      .resize(WIDTH, HEIGHT, { fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
    last = { buf, quality };
    if (buf.length <= MAX_KB * 1024) return last;
  }
  return last;
}

/* ---- credits ----------------------------------------------------------- */

function writeCredits(rows) {
  const lines = [];
  lines.push("# Fallback photo credits");
  lines.push("");
  lines.push(
    "Every photo in this folder comes from [Unsplash](https://unsplash.com/license). " +
      "The Unsplash License allows free commercial use without permission; attribution " +
      "is appreciated rather than required, and this file is that attribution."
  );
  lines.push("");
  lines.push(
    "**None of these is a photograph of a real Rockaway venue.** They are stand-ins, " +
      "used by `dist/index.html` when an event has no picture of its own. A venue only " +
      "ever maps to the photo that matches its mood, never to one captioned as if it " +
      "were that place. If a venue ever supplies its own photo, it belongs in the " +
      "Notion `Image` column, which beats everything here."
  );
  lines.push("");
  lines.push("Generated by `scripts/fetch-fallback-photos.js`. Re-run it to rebuild.");
  lines.push("");
  lines.push("| File | Photographer | Unsplash | Shows | Size |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      "| `" + r.slot + ".jpg` | " + r.by + " | [" + r.id + "](" + r.page + ") | " +
        r.shows + " | " + r.kb + " KB |"
    );
  }
  lines.push("");
  lines.push(
    "Total: " + rows.length + " files, " +
      Math.round(rows.reduce((a, r) => a + r.bytes, 0) / 1024) + " KB."
  );
  lines.push("");
  fs.writeFileSync(path.join(OUT_DIR, "CREDITS.md"), lines.join("\n"), "utf8");
}

/* ---- main -------------------------------------------------------------- */

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const wanted = only.length ? PHOTOS.filter((p) => only.includes(p.slot)) : PHOTOS;
  if (!wanted.length) {
    console.error("No slot matched " + only.join(", "));
    process.exit(1);
  }

  const done = [];
  const failures = [];
  for (const p of wanted) {
    const out = path.join(OUT_DIR, p.slot + ".jpg");
    if (fs.existsSync(out) && !force) {
      const bytes = fs.statSync(out).size;
      done.push(Object.assign({}, p, { bytes, kb: Math.round(bytes / 1024) }));
      console.log(pad(p.slot) + "  kept    " + Math.round(bytes / 1024) + " KB");
      continue;
    }
    try {
      const raw = await download(sourceUrl(p.id));
      const meta = await sharp(raw).metadata();
      const { buf, quality } = await squeeze(raw);
      fs.writeFileSync(out, buf);
      done.push(Object.assign({}, p, { bytes: buf.length, kb: Math.round(buf.length / 1024) }));
      console.log(
        pad(p.slot) +
          "  ok      " + Math.round(buf.length / 1024) + " KB" +
          "  q" + quality +
          "  (source " + meta.width + "x" + meta.height + ")"
      );
    } catch (e) {
      failures.push({ slot: p.slot, why: (e && e.message) || String(e) });
      console.log(pad(p.slot) + "  FAILED  " + ((e && e.message) || e));
    }
  }

  // Only rewrite CREDITS.md from a complete set, so a partial run cannot
  // silently drop an attribution for a file that is still on disk.
  const all = PHOTOS.map((p) => {
    const f = path.join(OUT_DIR, p.slot + ".jpg");
    if (!fs.existsSync(f)) return null;
    const bytes = fs.statSync(f).size;
    return Object.assign({}, p, { bytes, kb: Math.round(bytes / 1024) });
  }).filter(Boolean);
  writeCredits(all);

  const total = all.reduce((a, r) => a + r.bytes, 0);
  console.log(
    "\n" + all.length + "/" + PHOTOS.length + " photos on disk, " +
      Math.round(total / 1024) + " KB total, " +
      "largest " + Math.max(...all.map((r) => r.kb)) + " KB"
  );
  console.log("wrote " + path.relative(ROOT, path.join(OUT_DIR, "CREDITS.md")).replace(/\\/g, "/"));
  if (failures.length) {
    console.log("\nFAILED: " + failures.map((f) => f.slot + " (" + f.why + ")").join(", "));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function pad(s) {
  return (s + "                    ").slice(0, 18);
}
