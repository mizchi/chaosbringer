import { describe, expect, it } from "vitest";
import { faultFirings, unfiredFaults } from "./firings.js";
import type { CrawlReport } from "./types.js";

const report = (partial: Partial<CrawlReport>) => partial as CrawlReport;

describe("faultFirings", () => {
  it("reads all four layers into one shape", () => {
    // The point of the function: the network layer says `injected`, the other
    // three say `fired`, and lifecycle labels its row `name` where the rest say
    // `rule`. A caller should never have to know that.
    expect(
      faultFirings(
        report({
          faultInjections: [{ rule: "n", matched: 3, injected: 2, suppressed: 1 }],
          runtimeFaults: [{ rule: "r", matched: 2, fired: 1 }],
          lifecycleFaults: [{ name: "l", matched: 1, fired: 1, errored: 1 }],
          iframeFaults: [
            { rule: "i", selector: "iframe", action: "never-load", matched: 4, fired: 0 },
          ],
        }),
      ),
    ).toEqual([
      { name: "n", layer: "network", matched: 3, fired: 2, suppressed: 1, errored: 0, counted: true },
      { name: "r", layer: "runtime", matched: 2, fired: 1, suppressed: 0, errored: 0, counted: true },
      { name: "l", layer: "lifecycle", matched: 1, fired: 1, suppressed: 0, errored: 1, counted: true },
      { name: "i", layer: "iframe", matched: 4, fired: 0, suppressed: 0, errored: 0, counted: true },
    ]);
  });

  it("returns nothing for a report that configured nothing", () => {
    expect(faultFirings(report({}))).toEqual([]);
    expect(unfiredFaults(report({}))).toEqual([]);
  });

  it("never emits an undefined counter, whatever the row looked like", () => {
    // A row missing `matched` used to come back with `matched: undefined`, and
    // the diagnosis below then read "matched undefinedx and never fired".
    const [row] = faultFirings(report({ faultInjections: [{ rule: "r" } as never] }));
    expect(row).toEqual({
      name: "r",
      layer: "network",
      matched: 0,
      fired: 0,
      suppressed: 0,
      errored: 0,
      counted: false,
    });
  });

  it("labels a nameless row rather than leaving it blank", () => {
    const [row] = faultFirings(report({ runtimeFaults: [{ matched: 1, fired: 1 } as never] }));
    expect(row?.name).toBe("(unnamed)");
  });
});

describe("unfiredFaults", () => {
  it("separates the two ordinary failures", () => {
    expect(
      unfiredFaults(
        report({
          faultInjections: [{ rule: "wrong-pattern", matched: 0, injected: 0 }],
          runtimeFaults: [{ rule: "declined", matched: 3, fired: 0 }],
        }),
      ),
    ).toEqual([
      expect.stringContaining('network fault "wrong-pattern" never matched anything'),
      expect.stringMatching(/runtime fault "declined" matched 3x and never fired/),
    ]);
  });

  it("says a rule ahead of it answered, when that is what happened", () => {
    const [problem] = unfiredFaults(
      report({ faultInjections: [{ rule: "loser", matched: 3, injected: 0, suppressed: 2 }] }),
    );
    expect(problem).toContain("2 decision(s) lost to a rule ahead of it");
  });

  it("reports an unmeasured row as undecided, not as didn't-fire", () => {
    // The third case, and it used to be folded into the second with an
    // `undefined` in the sentence. "Nothing measured it" and "the policy said
    // no" are different findings and lead to different fixes.
    const problems = unfiredFaults(report({ faultInjections: [{ rule: "r" } as never] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no usable counters");
    expect(problems[0]).not.toContain("undefined");
    expect(problems[0]).not.toContain("firing policy");
  });

  it("stays quiet about faults that fired", () => {
    expect(
      unfiredFaults(report({ faultInjections: [{ rule: "ok", matched: 1, injected: 1 }] })),
    ).toEqual([]);
  });

  it("restricts to the names asked for, and flags one it never saw", () => {
    const r = report({
      faultInjections: [{ rule: "ignored", matched: 0, injected: 0 }],
      runtimeFaults: [{ rule: "watched", matched: 0, fired: 0 }],
    });
    expect(unfiredFaults(r, ["watched"])).toEqual([
      expect.stringContaining('runtime fault "watched" never matched anything'),
    ]);
    expect(unfiredFaults(r, ["typo"])).toEqual([
      expect.stringContaining('no layer reported stats for a fault named "typo"'),
    ]);
  });
});
