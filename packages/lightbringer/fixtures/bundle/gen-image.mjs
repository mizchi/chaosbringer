// Generate a real, heavy, oversized raster (1600×1200 noisy RGB PNG) so the media
// over-fetch check has actual bytes to report (a data: URL would be 0 KB). Noise
// makes it incompressible (~real photo weight). Deterministic (seeded LCG), written
// to public/ which is gitignored — regenerated at build time.
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 1600;
const H = 1200;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
fs.mkdirSync(dir, { recursive: true });

// CRC32 (PNG chunk checksum)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
// raw scanlines: filter byte (0) + W*3 noisy bytes
const raw = Buffer.alloc(H * (1 + W * 3));
let seed = 0x1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) & 0xff;
let p = 0;
for (let y = 0; y < H; y++) {
  raw[p++] = 0;
  for (let x = 0; x < W * 3; x++) raw[p++] = rnd();
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(dir, "photo.png"), png);
console.log(`wrote public/photo.png (${W}x${H}, ${Math.round(png.length / 1024)}KB)`);
