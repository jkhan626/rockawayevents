// Rasterize dist/og.svg -> dist/og.png (1200x630) and dist/icons/icon.svg -> 192/512 PNGs.
// Uses sharp from the sibling Wedding project so this repo stays dependency-free.
const path = require("path");
const sharp = require(path.resolve(__dirname, "../../Wedding/node_modules/sharp"));
const dist = path.resolve(__dirname, "../dist");
(async () => {
  await sharp(path.join(dist, "og.svg")).resize(1200, 630).png().toFile(path.join(dist, "og.png"));
  for (const s of [192, 512]) {
    await sharp(path.join(dist, "icons/icon.svg")).resize(s, s).png().toFile(path.join(dist, `icons/icon-${s}.png`));
  }
  await sharp(path.join(dist, "icons/icon.svg")).resize(180, 180).png().toFile(path.join(dist, "apple-touch-icon.png"));
  console.log("rasterized og.png, icon-192.png, icon-512.png, apple-touch-icon.png");
})().catch((e) => { console.error(e); process.exit(1); });
