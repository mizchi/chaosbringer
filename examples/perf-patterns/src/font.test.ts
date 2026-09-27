import { describe, expect, it } from "vitest";
import { boxFont } from "./font.js";

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
});
