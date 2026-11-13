import type { FaultRule } from "@mizchi/playwright-faults";
import { createRng as sharedCreateRng } from "@mizchi/playwright-faults/network";
import type { Route } from "playwright";
import { describe, expect, it } from "vitest";
import {
  applyFault,
  compileFaultRules,
  faultStatsOf,
  pickFaultRule,
  toRegExp,
} from "./fault-router.js";
import { createRng } from "./random.js";

/**
 * Characterisation of the rule decision, with no browser.
 *
 * The decision is shared between the Playwright route handler, the load
 * runner and (through `@mizchi/playwright-faults/network`) adapters that are
 * not Playwright at all. Every one of them depends on three things staying
 * put: which rule wins, how many random numbers a request consumes, and what
 * the counters say afterwards. The crawler shares one RNG between fault
 * draws, action selection and lifecycle decisions, so one extra or missing
 * draw per request re-points every seeded run that came before. These cases
 * were written against the code before the decision moved packages and pin
 * the exact sequences, so a move that changes any of them fails here rather
 * than in somebody's reproduction command.
 */

/** RNG that hands out a fixed script of values and counts the draws. */
function countingRng(values: number[]): { next(): number; calls: number } {
  let i = 0;
  return {
    calls: 0,
    next() {
      this.calls++;
      return values[i++ % values.length]!;
    },
  };
}

const status = (s: number) => ({ kind: "status", status: s }) as const;

describe("which rules are consulted", () => {
  it("does not consult a probability rule once an earlier rule has won", () => {
    const compiled = compileFaultRules([
      { name: "always", urlPattern: /\/api\//, fault: status(500) },
      { name: "maybe", urlPattern: /\/api\//, fault: status(503), probability: 0.5 },
    ]);
    const rng = countingRng([0]);
    const winner = pickFaultRule(compiled, "http://x.test/api/cart", "GET", rng);
    expect(winner?.rule.name).toBe("always");
    expect(rng.calls).toBe(0);
    expect(compiled[1]!.matched).toBe(0);
    expect(faultStatsOf(compiled)).toEqual([
      { rule: "always", matched: 1, injected: 1 },
      { rule: "maybe", matched: 0, injected: 0 },
    ]);
  });

  it("advances a scheduled rule behind a winner and records the lost inject as suppressed", () => {
    const compiled = compileFaultRules([
      { name: "always", urlPattern: /\/api\//, fault: status(500) },
      {
        name: "sched",
        urlPattern: /\/api\//,
        fault: status(503),
        schedule: { decisions: ["inject", "pass"] },
      },
    ]);
    const rng = countingRng([0]);
    pickFaultRule(compiled, "http://x.test/api/cart", "GET", rng); // occurrence 0: inject, lost
    pickFaultRule(compiled, "http://x.test/api/cart", "GET", rng); // occurrence 1: pass
    expect(rng.calls).toBe(0);
    expect(faultStatsOf(compiled)).toEqual([
      { rule: "always", matched: 2, injected: 2 },
      { rule: "sched", matched: 2, injected: 0, suppressed: 1 },
    ]);
  });

  it("draws only for 0 < probability < 1, exactly once per consulted rule", () => {
    const cases: Array<[string, Partial<FaultRule>, number]> = [
      ["schedule", { schedule: { decisions: ["pass"] } }, 0],
      ["no probability", {}, 0],
      ["probability 1", { probability: 1 }, 0],
      ["probability 1.5", { probability: 1.5 }, 0],
      ["probability 0", { probability: 0 }, 0],
      ["probability -1", { probability: -1 }, 0],
      ["probability 0.5", { probability: 0.5 }, 1],
    ];
    for (const [label, extra, draws] of cases) {
      const compiled = compileFaultRules([
        { urlPattern: /\/api\//, fault: status(500), ...extra },
      ]);
      const rng = countingRng([0.99]);
      pickFaultRule(compiled, "http://x.test/api/a", "GET", rng);
      expect(rng.calls, label).toBe(draws);
    }

    // Two probabilistic rules that both lose: each consulted rule draws once.
    const two = compileFaultRules([
      { urlPattern: /\/api\//, fault: status(500), probability: 0.5 },
      { urlPattern: /\/api\//, fault: status(503), probability: 0.5 },
    ]);
    const rng = countingRng([0.99]);
    expect(pickFaultRule(two, "http://x.test/api/a", "GET", rng)).toBeNull();
    expect(rng.calls).toBe(2);
  });
});

describe("a seeded sequence", () => {
  const rules = (): FaultRule[] => [
    { name: "a-half", urlPattern: /\/api\/a/, fault: status(500), probability: 0.5 },
    {
      name: "api-sched",
      urlPattern: /\/api\//,
      fault: status(503),
      schedule: { decisions: ["inject", "pass", "pass"], afterEnd: "repeat" },
    },
    { name: "b-post", urlPattern: /\/api\/b/, methods: ["post"], fault: { kind: "abort" }, probability: 0.3 },
  ];
  const inputs: Array<[string, string]> = [
    ["http://x.test/api/a", "GET"],
    ["http://x.test/api/b", "POST"],
    ["http://x.test/api/b", "GET"],
    ["http://x.test/api/a", "GET"],
    ["http://x.test/other", "GET"],
    ["http://x.test/api/b", "POST"],
    ["http://x.test/api/a", "POST"],
    ["http://x.test/api/b", "POST"],
    ["http://x.test/api/a", "GET"],
    ["http://x.test/api/c", "DELETE"],
    ["http://x.test/api/b", "POST"],
    ["http://x.test/api/a", "GET"],
  ];

  function run(seed: number) {
    const compiled = compileFaultRules(rules());
    const base = createRng(seed);
    let draws = 0;
    const rng = {
      next() {
        draws++;
        return base.next();
      },
    };
    const trace = inputs.map(([url, method]) => {
      const before = draws;
      const winner = pickFaultRule(compiled, url, method, rng);
      return `${winner?.rule.name ?? "-"}/${draws - before}`;
    });
    return { trace, stats: faultStatsOf(compiled) };
  }

  it("is identical for the same seed and the same inputs", () => {
    expect(run(1234)).toEqual(run(1234));
  });

  it("matches the recorded winner and draw sequence for seed 1234", () => {
    // `winner/draws` per request. Recorded on the code before the decision
    // moved to `@mizchi/playwright-faults/network`; a change to draw order or
    // count shows up as a diff in this list, not only in the stats.
    expect(run(1234)).toMatchInlineSnapshot(`
      {
        "stats": [
          {
            "injected": 4,
            "matched": 5,
            "rule": "a-half",
          },
          {
            "injected": 3,
            "matched": 11,
            "rule": "api-sched",
            "suppressed": 1,
          },
          {
            "injected": 0,
            "matched": 2,
            "rule": "b-post",
          },
        ],
        "trace": [
          "a-half/1",
          "-/1",
          "-/0",
          "api-sched/1",
          "-/0",
          "-/1",
          "a-half/1",
          "api-sched/0",
          "a-half/1",
          "-/0",
          "api-sched/0",
          "a-half/1",
        ],
      }
    `);
  });
});

describe("matching", () => {
  it("compares methods upper-cased and resourceTypes lower-cased", () => {
    const compiled = compileFaultRules([
      { name: "m", urlPattern: /\/api\//, methods: ["post"], fault: status(500) },
      { name: "rt", urlPattern: /\/img\//, resourceTypes: ["Image"], fault: status(500) },
    ]);
    const rng = countingRng([0]);
    expect(pickFaultRule(compiled, "http://x.test/api/a", "POST", rng)?.rule.name).toBe("m");
    expect(pickFaultRule(compiled, "http://x.test/api/a", "GET", rng)).toBeNull();
    expect(pickFaultRule(compiled, "http://x.test/img/a", "GET", rng, "IMAGE")?.rule.name).toBe("rt");
    expect(pickFaultRule(compiled, "http://x.test/img/a", "GET", rng, "script")).toBeNull();
    // No resource type known (the load runner, any non-Playwright transport):
    // a rule that names resource types never matches.
    expect(pickFaultRule(compiled, "http://x.test/img/a", "GET", rng)).toBeNull();
    expect(faultStatsOf(compiled)).toEqual([
      { rule: "m", matched: 1, injected: 1 },
      { rule: "rt", matched: 1, injected: 1 },
    ]);
  });

  it("does not alternate on a /g pattern", () => {
    const compiled = compileFaultRules([{ urlPattern: /\/api\//g, fault: status(500) }]);
    const rng = countingRng([0]);
    const hits = [0, 1, 2, 3].map(
      () => pickFaultRule(compiled, "http://x.test/api/a", "GET", rng) !== null,
    );
    expect(hits).toEqual([true, true, true, true]);
    expect(toRegExp(/a/gy)?.flags).toBe("");
  });

  it("refuses an invalid urlPattern, naming the rule", () => {
    expect(() =>
      compileFaultRules([{ name: "cart", urlPattern: "(", fault: status(500) }]),
    ).toThrow(/^chaosbringer: faultInjection rule "cart" has an invalid urlPattern/);
    expect(() =>
      compileFaultRules([
        { urlPattern: /ok/, fault: status(500) },
        { urlPattern: "(", fault: status(500) },
      ]),
    ).toThrow(/rule #1 has an invalid urlPattern/);
    expect(toRegExp("(")).toBeNull();
  });
});

describe("faultStatsOf", () => {
  it("labels by name, else by pattern, and lists suppressed only when non-zero", () => {
    const compiled = compileFaultRules([
      { name: "named", urlPattern: /\/a/, fault: status(500) },
      { urlPattern: "/b", fault: status(500) },
    ]);
    compiled[1]!.suppressed = 2;
    expect(faultStatsOf(compiled)).toEqual([
      { rule: "named", matched: 0, injected: 0 },
      { rule: "/\\/b/", matched: 0, injected: 0, suppressed: 2 },
    ]);
  });

  it("returns fresh objects on every call", () => {
    const compiled = compileFaultRules([{ name: "r", urlPattern: /\/a/, fault: status(500) }]);
    const first = faultStatsOf(compiled);
    first[0]!.matched = 99;
    expect(faultStatsOf(compiled)[0]!.matched).toBe(0);
    expect(compiled[0]!.matched).toBe(0);
  });

  it("keeps the caller's rule object as `rule`", () => {
    const rule: FaultRule = { urlPattern: /\/a/, fault: status(500) };
    expect(compileFaultRules([rule])[0]!.rule).toBe(rule);
  });
});

describe("seeded RNG", () => {
  it("produces the recorded mulberry32 sequence", () => {
    // Adapters outside chaosbringer reuse this generator; a seed has to mean
    // the same run on every one of them.
    const seq = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 10 }, () => rng.next());
    };
    expect([seq(0), seq(1234), seq(0xffffffff)]).toMatchInlineSnapshot(`
      [
        [
          0.26642920868471265,
          0.0003297457005828619,
          0.2232720274478197,
          0.1462021479383111,
          0.46732782293111086,
          0.5450490827206522,
          0.6152513844426721,
          0.6489853798411787,
          0.45600721263326705,
          0.581218967679888,
        ],
        [
          0.07329497812315822,
          0.7034119898453355,
          0.9028560190927237,
          0.9705493662040681,
          0.04096397617831826,
          0.11776310740970075,
          0.1617849813774228,
          0.8027570187114179,
          0.3989296858198941,
          0.12749109929427505,
        ],
        [
          0.8964226141106337,
          0.189478256739676,
          0.7156526781618595,
          0.9440599093213677,
          0.8452364315744489,
          0.5391399988438934,
          0.6804977387655526,
          0.4755720964167267,
          0.13585773925296962,
          0.9884445976931602,
        ],
      ]
    `);
  });

  it("is the same generator `@mizchi/playwright-faults/network` hands to other adapters", () => {
    for (const seed of [0, 1234, 0xffffffff]) {
      const ours = createRng(seed);
      const shared = sharedCreateRng(seed);
      const a = Array.from({ length: 10 }, () => ours.next());
      const b = Array.from({ length: 10 }, () => shared.next());
      expect(b, `seed ${seed}`).toEqual(a);
    }
  });
});

describe("applyFault defaults on a route", () => {
  function fakeRoute() {
    const calls: Array<[string, unknown]> = [];
    const route = {
      abort: async (code?: string) => void calls.push(["abort", code]),
      fulfill: async (opts: unknown) => void calls.push(["fulfill", opts]),
      fallback: async () => void calls.push(["fallback", undefined]),
    } as unknown as Route;
    return { route, calls };
  }

  it("aborts with 'failed' and fulfils {\"error\":<status>} as JSON by default", async () => {
    const { route, calls } = fakeRoute();
    await applyFault(route, { kind: "abort" });
    await applyFault(route, { kind: "abort", errorCode: "timedout" });
    await applyFault(route, { kind: "status", status: 503 });
    await applyFault(route, { kind: "status", status: 500, body: "", contentType: "text/plain" });
    expect(calls).toEqual([
      ["abort", "failed"],
      ["abort", "timedout"],
      ["fulfill", { status: 503, body: '{"error":503}', contentType: "application/json" }],
      ["fulfill", { status: 500, body: "", contentType: "text/plain" }],
    ]);
  });
});
