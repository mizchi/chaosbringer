import { describe, expect, it } from "vitest";
import { boxFont, EXTRA_FIRST } from "./font.js";

/** Table tag → [offset, length]. */
function tables(font: Buffer): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const rec = 12 + 16 * i;
    out[font.toString("ascii", rec, rec + 4)] = [font.readUInt32BE(rec + 8), font.readUInt32BE(rec + 12)];
  }
  return out;
}

/** Glyph id for code point `c`, read off the format-4 cmap subtable. */
function glyphFor(font: Buffer, c: number): number {
  const sub = tables(font).cmap![0] + font.readUInt32BE(tables(font).cmap![0] + 8);
  const segX2 = font.readUInt16BE(sub + 6);
  for (let i = 0; i < segX2; i += 2) {
    const end = font.readUInt16BE(sub + 14 + i);
    const start = font.readUInt16BE(sub + 16 + segX2 + i);
    const delta = font.readUInt16BE(sub + 16 + 2 * segX2 + i);
    if (c >= start && c <= end) return (c + delta) % 0x10000;
  }
  return 0;
}

const wholeFileSum = (font: Buffer) => {
  let sum = 0;
  for (let i = 0; i < font.length; i += 4) sum = (sum + font.readUInt32BE(i)) >>> 0;
  return sum;
};

describe("boxFont", () => {
  it("writes a TrueType file with sorted, in-bounds tables and a valid whole-file checksum", () => {
    const font = boxFont("Test Sans");
    expect(font.readUInt32BE(0)).toBe(0x00010000);
    const n = font.readUInt16BE(4);
    const tags: string[] = [];
    for (let i = 0; i < n; i++) {
      const rec = 12 + 16 * i;
      tags.push(font.toString("ascii", rec, rec + 4));
      const offset = font.readUInt32BE(rec + 8);
      const length = font.readUInt32BE(rec + 12);
      expect(offset % 4).toBe(0);
      expect(offset + length).toBeLessThanOrEqual(font.length);
    }
    expect(tags).toEqual([...tags].sort());
    expect(tags).toEqual(expect.arrayContaining(["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"]));
    // With head.checkSumAdjustment set, the whole file sums to 0xB1B0AFBA.
    let sum = 0;
    for (let i = 0; i < font.length; i += 4) sum = (sum + font.readUInt32BE(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });

  it("adds extraGlyphs from U+4E00 on, with a long loca once glyf passes 128 KB", () => {
    const small = boxFont("Test Sans");
    const big = boxFont("Test Sans", { extraGlyphs: 2000 });
    expect(big.length).toBeGreaterThan(small.length + 2000 * 150);
    const t = tables(big);
    // head.indexToLocFormat (offset 50): long; maxp.numGlyphs (offset 4): 96 + 2000.
    expect(big.readInt16BE(t.head![0] + 50)).toBe(1);
    expect(big.readUInt16BE(t.maxp![0] + 4)).toBe(96 + 2000);
    expect(t.loca![1]).toBe((96 + 2000 + 1) * 4);
    expect(t.hmtx![1]).toBe((96 + 2000) * 4);
    // Code points map to their glyphs; the ASCII part is unchanged.
    expect(glyphFor(big, 65)).toBe(glyphFor(small, 65));
    expect(glyphFor(big, EXTRA_FIRST)).toBe(96);
    expect(glyphFor(big, EXTRA_FIRST + 1999)).toBe(96 + 1999);
    expect(glyphFor(big, EXTRA_FIRST + 2000)).toBe(0);
    expect(glyphFor(small, EXTRA_FIRST)).toBe(0);
    // Every extra glyph has data (distinct loca offsets), and the file checksum holds.
    const loca = t.loca![0];
    for (let g = 96; g < 96 + 2000; g++) expect(big.readUInt32BE(loca + 4 * (g + 1))).toBeGreaterThan(big.readUInt32BE(loca + 4 * g));
    expect(wholeFileSum(big)).toBe(0xb1b0afba);
    expect(boxFont("Test Sans", { extraGlyphs: 0 }).equals(small)).toBe(true);
    expect(() => boxFont("Test Sans", { extraGlyphs: -1 })).toThrow(RangeError);
  });
});
