import { describe, expect, it } from "vitest";
import { IGNORE_PRESETS, resolveIgnorePresets } from "./crawler.js";
import { matchesAnyPattern } from "./filters.js";

/**
 * The presets are regex strings consumed by `matchesAnyPattern`. If a
 * pattern is mis-escaped (forgotten backslash on a dot, wrong anchor)
 * it silently fails to match the third-party noise it's meant to
 * filter. These tests pin each preset to a realistic example string
 * so a regex typo on edit fails loudly.
 */
const REPRESENTATIVE_NOISE: Record<string, string[]> = {
  analytics: [
    "https://www.googletagmanager.com/gtm.js",
    "Failed to load https://connect.facebook.net/en_US/fbevents.js",
    "Mixpanel error from cdn.mixpanel.com",
  ],
  maps: [
    "GET https://maps.googleapis.com/maps/api/js failed",
    "https://tile.openstreetmap.org/1/0/0.png",
  ],
  "media-embeds": [
    "https://www.youtube.com/embed/abc",
    "https://player.vimeo.com/video/123",
  ],
  "pdf-orb": [
    "net::ERR_BLOCKED_BY_ORB",
    "Refused to load /docs/sample.pdf",
  ],
  "iframe-sandbox": [
    "Blocked a frame with origin \"null\" from accessing a cross-origin frame.",
  ],
};

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

  describe("preset patterns match representative noise (regression guard)", () => {
    for (const [preset, samples] of Object.entries(REPRESENTATIVE_NOISE)) {
      it(`'${preset}' matches all of its targeted noise strings`, () => {
        const patterns = IGNORE_PRESETS[preset];
        for (const sample of samples) {
          expect(
            matchesAnyPattern(sample, patterns, "i"),
            `preset='${preset}' should match: ${sample}`,
          ).toBe(true);
        }
      });
    }

    it("presets do not match unrelated error strings (no over-broad regex)", () => {
      // A real application error must not be silently dropped by ANY preset.
      const realError = "TypeError: Cannot read properties of undefined";
      for (const [name, patterns] of Object.entries(IGNORE_PRESETS)) {
        expect(
          matchesAnyPattern(realError, patterns, "i"),
          `preset='${name}' incorrectly matched a real app error`,
        ).toBe(false);
      }
    });
  });
});
