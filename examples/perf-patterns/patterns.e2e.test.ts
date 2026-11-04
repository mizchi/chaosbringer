/**
 * Every pattern in src/patterns/, both variants, crawled with perf on:
 *
 *   slow  → the problem is measured on the expected perfKey
 *   fixed → the expected metric improves by at least `minImprovement`,
 *           and the crawl still reaches the same pages with no new error clusters
 *   budgets → when emit-budgets budgets the pattern's metric: the budgets
 *           `perf emit-budgets` writes from the fixed runs hold a fresh batch
 *           of fixed runs on that metric, and `perf gate` fails the slow runs on it
 *
 * Patterns run one after another (see vitest.config.ts). `PATTERN=<id>` runs one;
 * `PATTERN_SHARD=<i>/<n>` runs the i-th of n round-robin shards (CI splits the
 * catalog over parallel jobs this way).
 */

import { describe, expect, it } from "vitest";
import { compilePerfKeyGlob } from "chaosbringer";
import { budgetsWorkdir, EMITTED_BUDGET_METRIC, emitBudgetsCli, gateCli, type GateFinding } from "./src/budgets.js";
import { measurePattern, measureVariant, type PatternMeasurement } from "./src/measure.js";
import { loadPatterns, shardPatterns } from "./src/registry.js";

const patterns = shardPatterns(await loadPatterns(), process.env.PATTERN_SHARD);
const runs = Number(process.env.PERF_PATTERN_RUNS ?? 3);

// Tests in this file run in order (nothing is concurrent): each pattern's
// assertions read the measurement its first test took.
describe("perf patterns", () => {
  it("has patterns", () => {
    expect(patterns.length).toBeGreaterThan(0);
  });

  for (const pattern of patterns) {
    describe(`${pattern.id} (${pattern.category})`, () => {
      let m: PatternMeasurement;

      it("measures both variants", async () => {
        m = await measurePattern(pattern, { runs });
        console.log(
          `[${pattern.id}] ${pattern.expect.key} ${pattern.expect.metric}: slow ${m.slow.median} (${m.slow.values.join(",")}) → fixed ${m.fixed.median} (${m.fixed.values.join(",")})`,
        );
        for (const a of m.also) console.log(`[${pattern.id}]   also ${a.expect.metric}: slow ${a.slow} → fixed ${a.fixed}`);
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

      for (const [i, also] of (pattern.expect.alsoExpect ?? []).entries()) {
        it(`fixed variant also improves ${also.metric}`, () => {
          expect(m, "measurement failed").toBeDefined();
          const a = m.also[i]!;
          const { ratio, absolute } = also.minImprovement;
          const detail = `slow ${a.slow} (${m.slow.also[i]!.values.join(",")}), fixed ${a.fixed} (${m.fixed.also[i]!.values.join(",")}), need ratio>=${ratio ?? "-"} absolute>=${absolute ?? "-"}`;
          expect(a.improvement.ok, detail).toBe(true);
        });
      }

      it("fixed variant visits the same pages and adds no error clusters", () => {
        expect(m, "measurement failed").toBeDefined();
        const slowPages = new Set(m.slow.pagesPerRun.flat());
        const slowClusters = new Set(m.slow.clustersPerRun.flat());
        for (const pages of m.fixed.pagesPerRun) expect(pages).toEqual([...slowPages].sort());
        const added = m.fixed.clustersPerRun.flat().filter((k) => !slowClusters.has(k));
        expect(added, "new error clusters on the fixed variant").toEqual([]);
      });

      // emit-budgets' floors, on the pattern's own key and metric, from both
      // sides: a fresh batch of fixed runs must stay within the budgets
      // emitted from the fixed runs above, and the slow variant must still
      // break them (or the floors would be too loose to catch the pattern).
      // Only patterns whose metric emit-budgets budgets (page.*, settledMs,
      // memory and the like it does not). The fresh side is a batch gated on
      // its medians, as perf.md tells CI to gate, not one run: one run's
      // scriptMs on a ~44 ms click read 77, an outlier no floor below the
      // pattern's own 10 ms threshold can absorb. Its other metrics are
      // printed, not failed, for the same reason (a ~100 ms fixed task reads
      // blockingMs 0 or 53 depending on whether it crosses 50 ms).
      const budgeted = EMITTED_BUDGET_METRIC[pattern.expect.metric];
      if (budgeted) {
        it(`budgets from the fixed runs pass fresh fixed runs and fail the slow ones on ${budgeted}`, async () => {
          expect(m, "measurement failed").toBeDefined();
          const key = compilePerfKeyGlob(pattern.expect.key);
          const onPattern = (v: GateFinding) => v.metric === budgeted && key.test(v.scope);
          const work = budgetsWorkdir(pattern.id);
          try {
            const budgets = await emitBudgetsCli(work.dir, m.fixed.reports);
            const fresh = await measureVariant(pattern, "fixed", { runs });
            const rerun = await gateCli(work.dir, "fresh", fresh.reports, budgets);
            const other = rerun.violations.filter((v) => !onPattern(v));
            if (other.length) console.log(`[${pattern.id}] fresh fixed runs, outside ${budgeted}: ${JSON.stringify(other)}`);
            expect(rerun.violations.filter(onPattern), "fresh fixed runs failed the budgets emitted from the fixed runs").toEqual([]);
            const slow = await gateCli(work.dir, "slow", m.slow.reports, budgets);
            const hit = slow.violations.filter(onPattern);
            expect(hit.length, `slow variant passed ${budgeted} on ${pattern.expect.key}: ${JSON.stringify(slow.violations)}`).toBeGreaterThan(0);
            expect(slow.exitCode).toBe(1);
          } finally {
            work.dispose();
          }
        });
      }
    });
  }
});
