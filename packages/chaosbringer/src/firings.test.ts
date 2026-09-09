import { describe, expect, it } from "vitest";
import { faultFirings, faultWarnings, unfiredFaults } from "./firings.js";
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

describe("faultWarnings", () => {
  it("warns on all four layers, not just the network one", () => {
    // The regression this function exists for: the run-end warning walked the
    // network layer's compiled rules, so a runtime, lifecycle or iframe fault
    // that never fired ended the run in silence.
    expect(
      faultWarnings(
        report({
          faultInjections: [{ rule: "n", matched: 0, injected: 0 }],
          runtimeFaults: [{ rule: "r", matched: 0, fired: 0 }],
          lifecycleFaults: [{ name: "l", matched: 0, fired: 0, errored: 0 }],
          iframeFaults: [
            { rule: "i", selector: "iframe", action: "never-load", matched: 0, fired: 0 },
          ],
        }),
      ).map((w) => `${w.event}:${w.data.layer}`),
    ).toEqual([
      "fault_rule_unmatched:network",
      "fault_rule_unmatched:runtime",
      "fault_rule_unmatched:lifecycle",
      "fault_rule_unmatched:iframe",
    ]);
  });

  it("distinguishes matched-but-declined from never-matched", () => {
    // The second diagnosis had no event at all: a rule whose pattern is right
    // and whose firing policy said no reported exactly like one that fired.
    expect(
      faultWarnings(
        report({
          faultInjections: [{ rule: "declined", matched: 3, injected: 0 }],
          runtimeFaults: [{ rule: "typo", matched: 0, fired: 0 }],
        }),
      ),
    ).toEqual([
      { event: "fault_rule_unfired", data: { rule: "declined", layer: "network", matched: 3 } },
      { event: "fault_rule_unmatched", data: { rule: "typo", layer: "runtime", matched: 0 } },
    ]);
  });

  it("passes `suppressed` through only when a rule ahead of it answered", () => {
    const [lost] = faultWarnings(
      report({ faultInjections: [{ rule: "loser", matched: 3, injected: 0, suppressed: 2 }] }),
    );
    expect(lost?.data.suppressed).toBe(2);
    const [plain] = faultWarnings(
      report({ faultInjections: [{ rule: "plain", matched: 3, injected: 0 }] }),
    );
    expect(plain?.data).not.toHaveProperty("suppressed");
  });

  it("omits `matched` on an unmeasured row rather than publishing a coerced 0", () => {
    // `matched: 0` here would assert a measurement nobody made — the same
    // conflation of "nothing happened" with "nothing was counted" that the
    // `counted` flag exists to keep apart.
    const warnings = faultWarnings(report({ faultInjections: [{ rule: "r" } as never] }));
    expect(warnings).toEqual([
      { event: "fault_rule_uncounted", data: { rule: "r", layer: "network" } },
    ]);
    expect(warnings[0]?.data).not.toHaveProperty("matched");
  });

  it("stays quiet about faults that fired, on every layer", () => {
    expect(
      faultWarnings(
        report({
          faultInjections: [{ rule: "n", matched: 1, injected: 1 }],
          runtimeFaults: [{ rule: "r", matched: 1, fired: 1 }],
          lifecycleFaults: [{ name: "l", matched: 1, fired: 1, errored: 0 }],
          iframeFaults: [
            { rule: "i", selector: "iframe", action: "never-load", matched: 1, fired: 1 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("says nothing for a run that configured no faults", () => {
    expect(faultWarnings(report({}))).toEqual([]);
  });
});
