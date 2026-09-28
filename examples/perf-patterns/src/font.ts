/**
 * A tiny TrueType encoder, so font patterns serve a real web font the browser
 * accepts (Chrome runs every downloaded font through its sanitizer, OTS, and
 * drops an invalid one). Printable ASCII; every glyph but the space is the
 * same filled box, so text set in it is visibly not the fallback font.
 * `extraGlyphs` adds that many more glyphs, mapped from U+4E00 on (the CJK
 * block), each a distinct many-point outline, to make a font as heavy as an
 * unsubsetted one (~200 bytes a glyph). `ascent` / `descent` set its
 * vertical metrics, and so its `line-height: normal`, for layout-shift patterns.
 */

const EM = 1000;
const ADVANCE = 600;
const FIRST = 32; // space
const LAST = 126; // ~
/** glyph 0 = .notdef, then one glyph per code point FIRST..LAST. */
const NUM_ASCII_GLYPHS = 1 + (LAST - FIRST + 1);
/** First code point of the `extraGlyphs`. */
export const EXTRA_FIRST = 0x4e00;
/** Points in each extra glyph's one contour. */
const EXTRA_POINTS = 40;
// The box: 100..500 × 0..700 font units.
const BOX = { xMin: 100, yMin: 0, xMax: 500, yMax: 700 };

class Writer {
  private bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v >>> 8).u8(v);
  }
  i16(v: number) {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }
  u32(v: number) {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  raw(b: Uint8Array) {
    for (const x of b) this.bytes.push(x);
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  buffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

function boxGlyph(): Buffer {
  const w = new Writer();
  w.i16(1).i16(BOX.xMin).i16(BOX.yMin).i16(BOX.xMax).i16(BOX.yMax);
  w.u16(3); // endPtsOfContours[0]: 4 points
  w.u16(0); // no instructions
  for (let i = 0; i < 4; i++) w.u8(0x01); // on-curve, 16-bit deltas
  // Points (100,0) (100,700) (500,700) (500,0), clockwise, as deltas.
  for (const dx of [100, 0, 400, 0]) w.i16(dx);
  for (const dy of [0, 700, 0, -700]) w.i16(dy);
  if (w.length % 2) w.u8(0); // short loca: offsets must be even
  return w.buffer();
}

/**
 * Extra glyph `k`: one closed contour of EXTRA_POINTS on-curve points on a
 * seeded wobbly ring inside the box, so no two glyphs are alike.
 */
function detailedGlyph(k: number): Buffer {
  let seed = (k + 1) * 2654435761;
  const rand = () => {
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >>> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    return seed / 0x100000000;
  };
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < EXTRA_POINTS; i++) {
    const a = (i / EXTRA_POINTS) * Math.PI * 2;
    const r = 120 + rand() * 180;
    xs.push(Math.round(300 + r * Math.cos(-a)));
    ys.push(Math.round(350 + r * Math.sin(-a)));
  }
  const w = new Writer();
  w.i16(1).i16(Math.min(...xs)).i16(Math.min(...ys)).i16(Math.max(...xs)).i16(Math.max(...ys));
  w.u16(EXTRA_POINTS - 1);
  w.u16(0);
  for (let i = 0; i < EXTRA_POINTS; i++) w.u8(0x01);
  xs.forEach((x, i) => w.i16(x - (i ? xs[i - 1]! : 0)));
  ys.forEach((y, i) => w.i16(y - (i ? ys[i - 1]! : 0)));
  if (w.length % 2) w.u8(0);
  return w.buffer();
}

function nameTable(family: string): Buffer {
  const names: Array<[number, string]> = [
    [1, family],
    [2, "Regular"],
    [3, `${family} Regular`],
    [4, `${family} Regular`],
    [6, `${family.replace(/[^A-Za-z0-9]/g, "")}-Regular`],
  ];
  const strings = names.map(([, s]) => Buffer.from(s, "utf16le").swap16());
  const w = new Writer();
  w.u16(0).u16(names.length).u16(6 + 12 * names.length);
  let offset = 0;
  names.forEach(([id], i) => {
    w.u16(3).u16(1).u16(0x409).u16(id).u16(strings[i]!.length).u16(offset);
    offset += strings[i]!.length;
  });
  for (const s of strings) w.raw(s);
  return w.buffer();
}

function checksum(b: Buffer): number {
  const padded = Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

export interface BoxFontOptions {
  /** Glyphs beyond printable ASCII, mapped from U+4E00 on (default 0). */
  extraGlyphs?: number;
  /**
   * Vertical metrics in font units of the 1000-unit em (defaults 800 and
   * 200), written to hhea, OS/2 typo and OS/2 win alike. Their sum is the
   * font's `line-height: normal`, in em thousandths.
   */
  ascent?: number;
  descent?: number;
}

/** A valid TrueType font named `family`: box glyphs for printable ASCII (plus `extraGlyphs`). */
export function boxFont(family = "Box Sans", { extraGlyphs = 0, ascent = 800, descent = 200 }: BoxFontOptions = {}): Buffer {
  if (!Number.isInteger(extraGlyphs) || extraGlyphs < 0 || NUM_ASCII_GLYPHS + extraGlyphs > 0xffff || EXTRA_FIRST + extraGlyphs > 0xfffe) {
    throw new RangeError(`extraGlyphs must be an integer from 0 to ${0xfffe - EXTRA_FIRST}`);
  }
  for (const [name, v] of [["ascent", ascent], ["descent", descent]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 0x7fff) throw new RangeError(`${name} must be an integer from 0 to 32767`);
  }
  const NUM_GLYPHS = NUM_ASCII_GLYPHS + extraGlyphs;
  const glyph = boxGlyph();
  // glyf: .notdef and space are empty, the rest are boxes, then the extras.
  const glyf = new Writer();
  const offsets: number[] = [];
  for (let g = 0; g < NUM_GLYPHS; g++) {
    offsets.push(glyf.length);
    const code = FIRST + g - 1;
    if (g >= NUM_ASCII_GLYPHS) glyf.raw(detailedGlyph(g - NUM_ASCII_GLYPHS));
    else if (g > 0 && code !== FIRST) glyf.raw(glyph);
  }
  offsets.push(glyf.length);
  // loca: short (offset / 2 in a u16) while it fits, long (u32) past 128 KB.
  const longLoca = glyf.length / 2 > 0xffff;
  const loca = new Writer();
  for (const o of offsets) longLoca ? loca.u32(o) : loca.u16(o / 2);

  const head = new Writer()
    .u32(0x00010000) // version
    .u32(0x00010000) // fontRevision
    .u32(0) // checkSumAdjustment, patched below
    .u32(0x5f0f3cf5) // magicNumber
    .u16(0x000b) // flags
    .u16(EM)
    .zeros(16) // created, modified
    .i16(BOX.xMin)
    .i16(BOX.yMin)
    .i16(BOX.xMax)
    .i16(BOX.yMax)
    .u16(0) // macStyle
    .u16(8) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(longLoca ? 1 : 0) // indexToLocFormat: short / long
    .i16(0); // glyphDataFormat

  const hhea = new Writer()
    .u32(0x00010000)
    .i16(ascent) // ascender
    .i16(-descent) // descender
    .i16(0) // lineGap
    .u16(ADVANCE) // advanceWidthMax
    .i16(0) // minLeftSideBearing
    .i16(ADVANCE - BOX.xMax) // minRightSideBearing
    .i16(BOX.xMax) // xMaxExtent
    .i16(1) // caretSlopeRise
    .i16(0) // caretSlopeRun
    .i16(0) // caretOffset
    .zeros(8) // reserved
    .i16(0) // metricDataFormat
    .u16(NUM_GLYPHS); // numberOfHMetrics

  const maxp = new Writer()
    .u32(0x00010000)
    .u16(NUM_GLYPHS)
    .u16(extraGlyphs ? EXTRA_POINTS : 4) // maxPoints
    .u16(1) // maxContours
    .u16(0)
    .u16(0)
    .u16(2) // maxZones
    .zeros(18);

  const glyfBytes = glyf.buffer();
  const hmtx = new Writer();
  for (let g = 0; g < NUM_GLYPHS; g++) {
    const empty = g === 0 || FIRST + g - 1 === FIRST;
    // lsb = the glyph's xMin (bytes 2-3 of its header in glyf).
    const lsb = g >= NUM_ASCII_GLYPHS ? glyfBytes.readInt16BE(offsets[g]! + 2) : empty ? 0 : BOX.xMin;
    hmtx.u16(ADVANCE).i16(lsb);
  }

  // cmap: one format-4 subtable. Segments: FIRST..LAST → glyph c - FIRST + 1,
  // then (with extras) EXTRA_FIRST.. → the extra glyphs, then the 0xFFFF terminator.
  const segments: Array<{ start: number; end: number; delta: number }> = [
    { start: FIRST, end: LAST, delta: 1 - FIRST },
    ...(extraGlyphs
      ? [{ start: EXTRA_FIRST, end: EXTRA_FIRST + extraGlyphs - 1, delta: NUM_ASCII_GLYPHS - EXTRA_FIRST }]
      : []),
    { start: 0xffff, end: 0xffff, delta: 1 },
  ];
  const segCount = segments.length;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  const cmap = new Writer()
    .u16(0)
    .u16(1)
    .u16(3)
    .u16(1)
    .u32(12)
    .u16(4)
    .u16(16 + 8 * segCount) // length
    .u16(0) // language
    .u16(segCount * 2)
    .u16(searchRange)
    .u16(Math.log2(searchRange / 2)) // entrySelector
    .u16(segCount * 2 - searchRange); // rangeShift
  for (const seg of segments) cmap.u16(seg.end);
  cmap.u16(0); // reservedPad
  for (const seg of segments) cmap.u16(seg.start);
  for (const seg of segments) cmap.u16((seg.delta + 0x10000) % 0x10000);
  for (const _ of segments) cmap.u16(0); // idRangeOffset

  const post = new Writer().u32(0x00030000).u32(0).i16(-100).i16(50).zeros(20);

  const os2 = new Writer()
    .u16(4) // version
    .i16(ADVANCE) // xAvgCharWidth
    .u16(400) // usWeightClass
    .u16(5) // usWidthClass
    .u16(0) // fsType: installable
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(75) // subscript
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(350) // superscript
    .i16(50)
    .i16(300) // strikeout
    .i16(0) // sFamilyClass
    .zeros(10) // panose
    .u32(1)
    .u32(0)
    .u32(0)
    .u32(0) // ulUnicodeRange: Basic Latin
    .raw(Buffer.from("NONE", "ascii"))
    .u16(0x0040) // fsSelection: REGULAR
    .u16(FIRST) // usFirstCharIndex
    .u16(extraGlyphs ? EXTRA_FIRST + extraGlyphs - 1 : LAST) // usLastCharIndex
    .i16(ascent)
    .i16(-descent)
    .i16(0) // sTypo*
    .u16(ascent)
    .u16(descent) // usWin*
    .u32(1)
    .u32(0) // ulCodePageRange: Latin 1
    .i16(500) // sxHeight
    .i16(700) // sCapHeight
    .u16(0) // usDefaultChar
    .u16(FIRST) // usBreakChar
    .u16(1); // usMaxContext

  const tables: Record<string, Buffer> = {
    "OS/2": os2.buffer(),
    cmap: cmap.buffer(),
    glyf: glyfBytes,
    head: head.buffer(),
    hhea: hhea.buffer(),
    hmtx: hmtx.buffer(),
    loca: loca.buffer(),
    maxp: maxp.buffer(),
    name: nameTable(family),
    post: post.buffer(),
  };
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const pow2 = 2 ** Math.floor(Math.log2(n));
  const dir = new Writer()
    .u32(0x00010000)
    .u16(n)
    .u16(pow2 * 16)
    .u16(Math.log2(pow2))
    .u16(n * 16 - pow2 * 16);
  let offset = 12 + 16 * n;
  const bodies: Buffer[] = [];
  for (const tag of tags) {
    const t = tables[tag]!;
    dir.raw(Buffer.from(tag, "ascii")).u32(checksum(t)).u32(offset).u32(t.length);
    const padded = Buffer.concat([t, Buffer.alloc((4 - (t.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  }
  const font = Buffer.concat([dir.buffer(), ...bodies]);
  // head.checkSumAdjustment = 0xB1B0AFBA − checksum of the whole font.
  const headOffset = 12 + 16 * n + bodies.slice(0, tags.indexOf("head")).reduce((s, b) => s + b.length, 0);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}
