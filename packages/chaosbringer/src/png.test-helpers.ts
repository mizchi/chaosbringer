/**
 * Real PNGs for e2e pages whose images the browser must decode and paint:
 * seeded noise (it does not compress, so its bytes per pixel are a photo's,
 * never an image LCP skips as low-entropy) and a solid colour (it compresses
 * to almost nothing, so LCP skips it).
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (const b of td) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function rgbPng(size: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const row = size * 3 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    // Each row starts with filter byte 0 (none), which Buffer.alloc left.
    for (let x = 0; x < size; x++) {
      const o = y * row + 1 + x * 3;
      const [r, g, b] = pixel(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A `size`×`size` RGB PNG of seeded noise over a colour gradient. */
export function noisePng(size: number, seed: number): Buffer {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) & 0x3f;
  };
  return rgbPng(size, (x, y) => [
    ((x * 255) / size + rand()) & 0xff,
    ((y * 255) / size + rand()) & 0xff,
    (((seed * 37) & 0xff) + rand()) & 0xff,
  ]);
}

/** A `size`×`size` PNG of one colour. */
export function solidPng(size: number): Buffer {
  return rgbPng(size, () => [200, 120, 40]);
}
