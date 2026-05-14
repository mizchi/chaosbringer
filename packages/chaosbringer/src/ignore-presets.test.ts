import { describe, expect, it } from "vitest";
import { IGNORE_PRESETS, resolveIgnorePresets } from "./crawler.js";

describe("resolveIgnorePresets", () => {
  it("resolves a single preset to its bundled patterns", () => {
    const out = resolveIgnorePresets("maps");
    expect(out).toEqual([...IGNORE_PRESETS.maps]);
  });

  it("unions comma-separated presets in declaration order", () => {
    const out = resolveIgnorePresets("maps,analytics");
    expect(out).toEqual([...IGNORE_PRESETS.maps, ...IGNORE_PRESETS.analytics]);
  });

  it("trims whitespace and ignores empty tokens", () => {
    const out = resolveIgnorePresets("  maps  , , analytics ");
    expect(out).toEqual([...IGNORE_PRESETS.maps, ...IGNORE_PRESETS.analytics]);
  });

  it("throws on unknown preset with the available list", () => {
    expect(() => resolveIgnorePresets("not-real")).toThrow(/unknown ignore preset "not-real"/);
    expect(() => resolveIgnorePresets("not-real")).toThrow(/Available:/);
  });

  it("ships the four documented presets", () => {
    for (const key of ["analytics", "maps", "media-embeds", "pdf-orb", "iframe-sandbox"]) {
      expect(IGNORE_PRESETS).toHaveProperty(key);
      expect(IGNORE_PRESETS[key].length).toBeGreaterThan(0);
    }
  });
});
