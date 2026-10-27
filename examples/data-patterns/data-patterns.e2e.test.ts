/**
 * Every pattern in src/patterns/, three crawls each, all with `strict` on and
 * the whole catalog suite (src/suite.ts):
 *
 *   buggy + bad data    → the expected signal, and only the declared ones
 *   buggy + benign data → clean: the signal comes from the data, not the page
 *   fixed + bad data    → clean: the fix handles exactly what broke the page
 *
 * plus proof that the data reached each run, and that each verdict would
 * have failed on another of the three runs (so none passes vacuously).
 * Oracle entries are crawled once and must be clean.
 *
 * Patterns run one after another (see vitest.config.ts). `PATTERN=<id>` runs
 * one; `PATTERN_SHARD=<i>/<n>` runs the i-th of n round-robin shards.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runCase } from "./src/detect.js";
import { loadPatterns, shardPatterns } from "./src/registry.js";
import { type CaseRun, describeSignal, judgeBuggy, judgeClean, judgeDelivered } from "./src/verdict.js";

const patterns = shardPatterns(await loadPatterns(), process.env.PATTERN_SHARD);

// Tests in this file run in order (nothing is concurrent): each entry's
// assertions read the crawls its beforeAll took.
describe("data patterns", () => {
  it("has patterns", () => {
    expect(patterns.length).toBeGreaterThan(0);
  });

  for (const pattern of patterns) {
    const expected = pattern.expect;
    describe(`${pattern.id} (${pattern.category})`, () => {
      if (expected.signal === "none") {
        // An oracle page has no bug: its one variant is served as `fixed`.
        it("is clean", async () => {
          const run = await runCase(pattern, "fixed", "none");
          expect(judgeClean(pattern, run)).toEqual([]);
        });
        return;
      }

      let buggyBad: CaseRun;
      let buggyBenign: CaseRun;
      let fixedBad: CaseRun;
      beforeAll(async () => {
        buggyBad = await runCase(pattern, "buggy", "bad");
        buggyBenign = await runCase(pattern, "buggy", "benign");
        fixedBad = await runCase(pattern, "fixed", "bad");
      });

      it(`buggy is flagged by ${describeSignal(expected.signal)}`, () => {
        expect(judgeBuggy(pattern, buggyBad)).toEqual([]);
      });

      it("buggy is clean on benign data", () => {
        expect(judgeClean(pattern, buggyBenign)).toEqual([]);
      });

      it("fixed is clean on the same bad data", () => {
        expect(judgeClean(pattern, fixedBad)).toEqual([]);
      });

      it("the data reached every run", () => {
        expect(judgeDelivered(pattern, buggyBad), "buggy + bad").toEqual([]);
        expect(judgeDelivered(pattern, buggyBenign), "buggy + benign").toEqual([]);
        expect(judgeDelivered(pattern, fixedBad), "fixed + bad").toEqual([]);
      });

      // A verdict that passes on every run proves nothing: each must fail
      // on a run it isn't meant for.
      it("each check can fail here", () => {
        expect(judgeClean(pattern, buggyBad), "judgeClean(buggy + bad)").not.toEqual([]);
        expect(judgeBuggy(pattern, fixedBad), "judgeBuggy(fixed + bad)").not.toEqual([]);
        expect(judgeBuggy(pattern, buggyBenign), "judgeBuggy(buggy + benign)").not.toEqual([]);
      });
    });
  }
});
