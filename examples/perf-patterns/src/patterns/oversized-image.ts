import { deflateSync } from "node:zlib";
import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const AVATARS = 8;
const SHOWN_PX = 128;
// What the server sends for each 128×128 slot: a 1024×1024 original, or an
// image resized for the slot (256 px covers a 2× display).
const SERVED_PX: Record<Variant, number> = { slow: 1024, fixed: 256 };

// --- a tiny PNG encoder, so the bytes are a real image the browser decodes ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * An RGB PNG of seeded noise over a colour gradient. Noise does not compress,
 * so the file size scales with the pixel count, like a photo would.
 */
function noisePng(size: number, seed: number): Buffer {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) & 0x3f;
  };
  const row = size * 3 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * row + 1 + x * 3;
      raw[o] = ((x * 255) / size + rand()) & 0xff;
      raw[o + 1] = ((y * 255) / size + rand()) & 0xff;
      raw[o + 2] = (((seed * 37) & 0xff) + rand()) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Built once per (size, avatar) and reused across crawls.
const cache = new Map<string, Buffer>();
function avatar(size: number, n: number): Buffer {
  const k = `${size}:${n}`;
  let png = cache.get(k);
  if (!png) cache.set(k, (png = noisePng(size, n + 1)));
  return png;
}

export default definePattern({
  id: "oversized-image",
  title: "Oversized images for small slots",
  category: "network",
  description:
    "An avatar grid shows eight 128×128 images, but each is the 1024×1024 original: 64× the pixels the slot needs (16× on a 2× display), megabytes of download and decode for thumbnails.",
  fix: "Serve images sized for the slot (a resized rendition, srcset/sizes for density), in a modern format.",
  routes: (variant) => ({
    "/": html(
      page(
        "Team",
        `<h1>Team</h1>
<div class="grid">${Array.from(
          { length: AVATARS },
          (_, i) => `<img src="/img/avatar.png?u=${i}" width="${SHOWN_PX}" height="${SHOWN_PX}" alt="Member ${i + 1}">`,
        ).join("\n")}</div>`,
        `<style>.grid { display: grid; grid-template-columns: repeat(4, ${SHOWN_PX}px); gap: 8px; }</style>`,
      ),
    ),
    "/img/avatar.png": handler((req, res) => {
      const u = Number(new URL(req.url ?? "/", "http://x").searchParams.get("u") ?? 0) % AVATARS;
      const png = avatar(SERVED_PX[variant], u);
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store" });
      res.end(png);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "network.encodedKB",
    direction: "lower",
    // slow: 8 × ~3 MB; fixed: 8 × ~190 KB (16× fewer pixels).
    minImprovement: { ratio: 8, absolute: 5000 },
  },
});
