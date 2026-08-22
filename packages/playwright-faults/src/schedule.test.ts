import { describe, expect, it } from "vitest";
import {
  buildDecisionHelperSource,
  decideFault,
  scheduleDecisionAt,
  serializeSchedule,
  validateFaultSchedule,
} from "./schedule.js";
import type { FaultSchedule, Rng } from "./types.js";

/** RNG that hands out a fixed script of values and counts draws. */
function scriptedRng(values: number[]): Rng & { draws: number } {
  let i = 0;
  return {
    draws: 0,
    next() {
      this.draws++;
      return values[i++ % values.length]!;
    },
  };
}

const never: Rng = {
  next() {
    throw new Error("RNG must not be consumed by a scheduled fault");
  },
};

describe("scheduleDecisionAt", () => {
  const table: FaultSchedule = { decisions: ["inject", "pass", "inject"] };

  it("reads the decision table by occurrence", () => {
    expect(scheduleDecisionAt(table, 0)).toBe("inject");
    expect(scheduleDecisionAt(table, 1)).toBe("pass");
    expect(scheduleDecisionAt(table, 2)).toBe("inject");
  });

  it("defaults to spent (pass) past the end", () => {
    expect(scheduleDecisionAt(table, 3)).toBe("pass");
    expect(scheduleDecisionAt(table, 99)).toBe("pass");
  });

  it("afterEnd: inject keeps firing", () => {
    const s: FaultSchedule = { decisions: ["pass"], afterEnd: "inject" };
    expect(scheduleDecisionAt(s, 0)).toBe("pass");
    expect(scheduleDecisionAt(s, 1)).toBe("inject");
    expect(scheduleDecisionAt(s, 1000)).toBe("inject");
  });

  it("afterEnd: repeat cycles the table", () => {
    const s: FaultSchedule = { decisions: ["inject", "pass"], afterEnd: "repeat" };
    expect([0, 1, 2, 3, 4].map((i) => scheduleDecisionAt(s, i))).toEqual([
      "inject",
      "pass",
      "inject",
      "pass",
      "inject",
    ]);
  });

  it("refuses to invent faults for a broken occurrence counter", () => {
    const s: FaultSchedule = { decisions: ["inject"], afterEnd: "inject" };
    expect(scheduleDecisionAt(s, -1)).toBe("pass");
    expect(scheduleDecisionAt(s, 1.5)).toBe("pass");
    expect(scheduleDecisionAt(s, Number.NaN)).toBe("pass");
  });

  it("treats an empty table as pass rather than throwing", () => {
    expect(scheduleDecisionAt({ decisions: [] }, 0)).toBe("pass");
  });
});

describe("decideFault", () => {
  it("schedule wins and consumes no RNG", () => {
    const rule = { schedule: { decisions: ["inject", "pass"] } as FaultSchedule };
    expect(decideFault(rule, 0, never)).toBe("inject");
    expect(decideFault(rule, 1, never)).toBe("pass");
  });

  it("falls back to the probability roll", () => {
    const rng = scriptedRng([0.1, 0.9]);
    const rule = { probability: 0.5 };
    expect(decideFault(rule, 0, rng)).toBe("inject"); // 0.1 < 0.5
    expect(decideFault(rule, 1, rng)).toBe("pass"); // 0.9 >= 0.5
    expect(rng.draws).toBe(2);
  });

  it("does not draw for p >= 1 / p <= 0, so seeds stay stable", () => {
    const rng = scriptedRng([0.5]);
    expect(decideFault({}, 0, rng)).toBe("inject");
    expect(decideFault({ probability: 1 }, 0, rng)).toBe("inject");
    expect(decideFault({ probability: 0 }, 0, rng)).toBe("pass");
    expect(rng.draws).toBe(0);
  });
});

describe("validateFaultSchedule", () => {
  it("passes a rule with no schedule", () => {
    expect(() => validateFaultSchedule("rule", { probability: 0.5 })).not.toThrow();
  });

  it("rejects probability + schedule together", () => {
    expect(() =>
      validateFaultSchedule("rule x", {
        probability: 0.5,
        schedule: { decisions: ["inject"] },
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects an empty decision table", () => {
    expect(() => validateFaultSchedule("rule x", { schedule: { decisions: [] } })).toThrow(
      /empty "schedule.decisions"/,
    );
  });

  it("rejects an unknown decision value", () => {
    expect(() =>
      validateFaultSchedule("rule x", {
        schedule: { decisions: ["inject", "nope" as unknown as "pass"] },
      }),
    ).toThrow(/schedule.decisions\[1\]/);
  });

  it("rejects an unknown afterEnd", () => {
    expect(() =>
      validateFaultSchedule("rule x", {
        schedule: {
          decisions: ["inject"],
          afterEnd: "loop" as unknown as "repeat",
        },
      }),
    ).toThrow(/schedule.afterEnd/);
  });
});

describe("serializeSchedule", () => {
  it("returns null when there is no schedule", () => {
    expect(serializeSchedule(undefined)).toBeNull();
  });

  it("materialises afterEnd so the in-page evaluator can skip defaulting", () => {
    expect(serializeSchedule({ decisions: ["inject"] })).toEqual({
      decisions: ["inject"],
      afterEnd: "pass",
    });
  });
});

describe("buildDecisionHelperSource", () => {
  // The in-page twin must agree with the Node-side helper on every case, or a
  // scheduled run means one thing in the crawler and another in the page.
  const inPageDecide = (
    fault: { probability?: number; schedule: ReturnType<typeof serializeSchedule> },
    occurrence: number,
    rolls: number[],
  ): boolean => {
    let i = 0;
    const body = `${buildDecisionHelperSource()}
    return __decide(f, occurrence);`;
    // eslint-disable-next-line no-new-func
    const fn = new Function("f", "occurrence", "__nextRoll", body) as (
      f: unknown,
      o: number,
      r: () => number,
    ) => boolean;
    // No `probability: 1` default here, deliberately. Both production
    // serializers apply that default, so injecting it too meant the table
    // could only ever compare inputs that had already been normalised — and
    // `undefined` was the one input on which the two evaluators disagreed
    // (node: always fire, page: never fire *and* burn a draw). A parity table
    // that pre-normalises its own inputs tests the normaliser, not the parity.
    return fn({ ...fault }, occurrence, () => rolls[i++ % rolls.length]!);
  };

  /** Draws taken, so "never fires" and "never fires but rolled anyway" differ. */
  const inPageDraws = (
    fault: { probability?: number; schedule: ReturnType<typeof serializeSchedule> },
    occurrence: number,
  ): number => {
    let draws = 0;
    inPageDecide(fault, occurrence, []);
    // `inPageDecide` closes over its own counter, so count through a roll that
    // records instead: same helper source, a roll that tallies.
    const body = `${buildDecisionHelperSource()}
    return __decide(f, occurrence);`;
    const fn = new Function("f", "occurrence", "__nextRoll", body) as (
      f: unknown,
      o: number,
      r: () => number,
    ) => boolean;
    fn({ ...fault }, occurrence, () => {
      draws++;
      return 0.5;
    });
    return draws;
  };

  // The occurrence-sanity values belong in *every* case, not in a Node-only
  // test: deleting the in-page `occurrence < 0 || (occurrence | 0) !==
  // occurrence` guard left all twenty tests green, because the parity table
  // only ever asked about ordinary occurrences. A guard the two sides do not
  // agree on is exactly the drift this table exists to prevent — `afterEnd:
  // "inject"` plus a broken counter is the case that invents faults.
  const BROKEN_OCCURRENCES = [-1, 1.5, Number.NaN];
  const cases: Array<{ schedule: FaultSchedule; occurrences: number[] }> = [
    {
      schedule: { decisions: ["inject", "pass", "inject"] },
      occurrences: [0, 1, 2, 3, 7, ...BROKEN_OCCURRENCES],
    },
    { schedule: { decisions: ["pass"], afterEnd: "inject" }, occurrences: [0, 1, 5, ...BROKEN_OCCURRENCES] },
    {
      schedule: { decisions: ["inject", "pass"], afterEnd: "repeat" },
      occurrences: [0, 1, 2, 3, ...BROKEN_OCCURRENCES],
    },
    // An empty table: both sides must pass rather than index into nothing.
    { schedule: { decisions: [] }, occurrences: [0, 1, ...BROKEN_OCCURRENCES] },
    { schedule: { decisions: [], afterEnd: "inject" }, occurrences: [0, 1, ...BROKEN_OCCURRENCES] },
  ];

  for (const [i, c] of cases.entries()) {
    it(`agrees with decideFault for case ${i}`, () => {
      for (const occ of c.occurrences) {
        const node = decideFault({ schedule: c.schedule }, occ, never) === "inject";
        const page = inPageDecide({ schedule: serializeSchedule(c.schedule) }, occ, [0.5]);
        expect(page, `occurrence ${occ}`).toBe(node);
      }
    });
  }

  it("agrees on the probability path too", () => {
    // 0.25 < 0.5 → inject; 0.75 >= 0.5 → pass.
    expect(inPageDecide({ probability: 0.5, schedule: null }, 0, [0.25])).toBe(true);
    expect(inPageDecide({ probability: 0.5, schedule: null }, 0, [0.75])).toBe(false);
    expect(decideFault({ probability: 0.5 }, 0, scriptedRng([0.25]))).toBe("inject");
    expect(decideFault({ probability: 0.5 }, 0, scriptedRng([0.75]))).toBe("pass");
  });

  // The three values the serializers normalise away, which is exactly why the
  // page side needs to agree on them: `buildDecisionHelperSource` is a public
  // export for callers writing their own init-script layer, and their
  // serializer is not this package's.
  for (const p of [undefined, 0, 1] as const) {
    it(`agrees on probability ${String(p)} without a serializer in between`, () => {
      const node = decideFault({ probability: p }, 0, scriptedRng([0.5])) === "inject";
      expect(inPageDecide({ probability: p, schedule: null }, 0, [0.5])).toBe(node);
    });
  }

  it("takes no draw on a decided probability, so the seed sequence is stable", () => {
    // `undefined` used to fall through to `__nextRoll() < undefined` — false
    // forever, and a draw consumed on the way. Either half alone is a bug: a
    // fault that never fires, and a seed that shifts when a rule is added.
    expect(inPageDraws({ probability: undefined, schedule: null }, 0)).toBe(0);
    expect(inPageDraws({ probability: 1, schedule: null }, 0)).toBe(0);
    expect(inPageDraws({ probability: 0, schedule: null }, 0)).toBe(0);
    expect(inPageDraws({ probability: 0.5, schedule: null }, 0)).toBe(1);
  });
});
