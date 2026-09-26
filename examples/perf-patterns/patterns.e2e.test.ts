/**
 * Every pattern in src/patterns/, both variants, crawled with perf on:
 *
 *   slow  → the problem is measured on the expected perfKey
 *   fixed → the expected metric improves by at least `minImprovement`,
 *           and the crawl still reaches the same pages with no new error clusters
 *
 * Patterns run one after another (see vitest.config.ts). `PATTERN=<id>` runs one.
 */

import { describe, expect, it } from "vitest";
import { measurePattern, type PatternMeasurement } from "./src/measure.js";
import { loadPatterns } from "./src/registry.js";

const patterns = await loadPatterns();
const runs = Number(process.env.PERF_PATTERN_RUNS ?? 3);

describe.sequential("perf patterns", () => {
  it("has patterns", () => {
    expect(patterns.length).toBeGreaterThan(0);
  });

  for (const pattern of patterns) {
    describe.sequential(`${pattern.id} (${pattern.category})`, () => {
      let m: PatternMeasurement;

      it("measures both variants", async () => {
        m = await measurePattern(pattern, { runs });
        console.log(
          `[${pattern.id}] ${pattern.expect.key} ${pattern.expect.metric}: slow ${m.slow.median} (${m.slow.values.join(",")}) → fixed ${m.fixed.median} (${m.fixed.values.join(",")})`,
        );
      });

      it(`slow variant is measured on ${pattern.expect.key}`, () => {
        expect(m, "measurement failed").toBeDefined();
        expect(m.slow.matchedKeys.length, `no span matched ${pattern.expect.key}`).toBeGreaterThan(0);
        for (const [run, n] of m.slow.matchedPerRun.entries()) {
          expect(n, `run ${run}: no ${pattern.expect.metric} on ${pattern.expect.key}`).toBeGreaterThan(0);
        }
        expect(m.fixed.matchedKeys, "fixed variant must be measured on the same keys").toEqual(m.slow.matchedKeys);
      });

      it(`fixed variant improves ${pattern.expect.metric}`, () => {
        expect(m, "measurement failed").toBeDefined();
        const { ratio, absolute } = pattern.expect.minImprovement;
        const detail = `slow ${m.slow.median}, fixed ${m.fixed.median}, need ratio>=${ratio ?? "-"} absolute>=${absolute ?? "-"}`;
        expect(m.improvement.ok, detail).toBe(true);
      });

      it("fixed variant visits the same pages and adds no error clusters", () => {
        expect(m, "measurement failed").toBeDefined();
        const slowPages = new Set(m.slow.pagesPerRun.flat());
        const slowClusters = new Set(m.slow.clustersPerRun.flat());
        for (const pages of m.fixed.pagesPerRun) expect(pages).toEqual([...slowPages].sort());
        const added = m.fixed.clustersPerRun.flat().filter((k) => !slowClusters.has(k));
        expect(added, "new error clusters on the fixed variant").toEqual([]);
      });
    });
  }
});
