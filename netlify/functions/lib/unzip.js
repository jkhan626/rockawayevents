// netlify/functions/lib/unzip.js
// Minimal ZIP reader, drop-in for fflate's unzipSync, built on Node's own zlib.
//
// Why this exists: ferry-core.js is copied verbatim from jamasha, where it does
// `require("fflate")` to unpack the NYC Ferry static GTFS zip. This project is
// deliberately zero-dependency (no node_modules, nothing for esbuild to bundle
// and nothing to keep patched), and Node 20 already ships everything needed:
// a ZIP entry is just a deflate-raw stream behind a fixed header, so the whole
// reader is the central directory walk below.
//
// Supports stored (method 0) and deflate (method 8) entries, which is all GTFS
// producers emit. Zip64 is not supported; GTFS feeds are far under the 4 GB
// where it becomes mandatory.

const { inflateRawSync } = require("zlib");

const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_CEN = 0x02014b50; // central directory file header
const SIG_LOC = 0x04034b50; // local file header

/**
 * Unpack a zip archive held in memory.
 * @param {Uint8Array|Buffer} data
 * @returns {Object<string, Uint8Array>} entry name -> decompressed bytes
 */
function unzipSync(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length);

  // Find the End Of Central Directory record. It sits at the tail, after an
  // optional comment of up to 65535 bytes, so scan backwards for the signature.
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("unzip: not a zip archive (no EOCD record)");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (cenOffset === 0xffffffff) {
    throw new Error("unzip: zip64 archives are not supported");
  }

  const out = Object.create(null);
  let p = cenOffset;

  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) {
      throw new Error("unzip: bad central directory entry at " + p);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // Directory entries carry no data.
    if (name.endsWith("/")) continue;

    // The local header repeats the name and has its own extra field, which can
    // differ in length from the central one, so read the real lengths here.
    if (buf.readUInt32LE(localOffset) !== SIG_LOC) {
      throw new Error("unzip: bad local header for " + name);
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + locNameLen + locExtraLen;
    const raw = buf.slice(start, start + compSize);

    if (method === 0) {
      out[name] = new Uint8Array(raw);
    } else if (method === 8) {
      out[name] = new Uint8Array(inflateRawSync(raw));
    } else {
      throw new Error("unzip: unsupported compression method " + method + " for " + name);
    }
  }

  return out;
}

module.exports = { unzipSync };
