import { BUDGET_METRIC } from "lightbringer/core";
import { describe, expect, it } from "vitest";
import { checkPerfBudgets, perfBudgetRulesFromJson } from "./budget.js";
import { fingerprintError } from "./clusters.js";
import { DEFAULT_OPTIONS } from "./defaults.js";
import { fakeSpan } from "./perf-fixtures.test-helpers.js";
import { compilePerfKeyGlob } from "./perf-key.js";
import { buildReproCommand, perfReproFlags } from "./repro-command.js";
import type { CrawlerOptions } from "./types.js";
import { validateOptions, validatePerfBudgets } from "./validate.js";

describe("compilePerfKeyGlob", () => {
  const matches = (glob: string, key: string) => compilePerfKeyGlob(glob).test(key);

  it("* matches any run of characters, spaces and slashes included", () => {
    expect(matches("/cart* :: click *", "/cart :: click #buy")).toBe(true);
    expect(matches("/cart* :: click *", "/cart/items/:id :: click button.add")).toBe(true);
    expect(matches("* :: load", "/ :: load")).toBe(true);
    expect(matches("*", "/anything :: at all")).toBe(true);
    expect(matches("/a*b", "/ab")).toBe(true); // a run may be empty
  });

  it("* spans line terminators a selector can carry from script-set text", () => {
    for (const sep of ["\r", "\n", " ", " "]) {
      expect(matches("*", `/ :: click a:has-text("a${sep}b")`)).toBe(true);
    }
  });

  it("matches the whole key, not a substring", () => {
    expect(matches("/cart :: load", "/cart :: load")).toBe(true);
    expect(matches("/cart", "/cart :: load")).toBe(false);
    expect(matches(":: load", "/cart :: load")).toBe(false);
    expect(matches("* :: load", "/cart :: click #load")).toBe(false);
  });

  it("treats every other character literally, as selectors contain them", () => {
    expect(matches("/ :: click a.nav[href]", "/ :: click a.nav[href]")).toBe(true);
    expect(matches("/ :: click a.nav", "/ :: click aXnav")).toBe(false);
    expect(matches("/q? :: load", "/q :: load")).toBe(false);
    expect(matches("/(x) :: load", "/(x) :: load")).toBe(true);
  });
});

describe("checkPerfBudgets", () => {
  const url = "http://localhost/cart";
  const click = fakeSpan("/cart :: click #buy", { durationMs: 300, blockingMs: 150, interactionMs: 180 });
  const load = fakeSpan("/cart :: load", { durationMs: 900, blockingMs: 0 });

  it("returns nothing without rules or spans", () => {
    expect(checkPerfBudgets([click], undefined, url)).toEqual([]);
    expect(checkPerfBudgets([click], [], url)).toEqual([]);
    expect(checkPerfBudgets([], [{ match: "*", budget: { durationMs: 1 } }], url)).toEqual([]);
  });

  it("creates a perf-budget.<metric> invariant violation naming key, measured and limit", () => {
    const errors = checkPerfBudgets([load, click], [{ match: "/cart :: click *", budget: { blockingMs: 100 } }], url, 42);
    expect(errors).toEqual([
      {
        type: "invariant-violation",
        invariantName: "perf-budget.blockingMs",
        message: '[perf-budget.blockingMs] /cart :: click #buy: blockingMs=150 > budget 100 (rule "/cart :: click *")',
        url,
        timestamp: 42,
      },
    ]);
  });

  it("passes at the limit and below it", () => {
    expect(checkPerfBudgets([click], [{ match: "*", budget: { blockingMs: 150, durationMs: 1000 } }], url)).toEqual([]);
  });

  it("applies every matching rule, not only the first", () => {
    const errors = checkPerfBudgets(
      [load, click],
      [
        { match: "*", budget: { durationMs: 500 } },
        { match: "/cart :: click *", budget: { durationMs: 200, interactionMs: 100 } },
      ],
      url,
    );
    expect(errors.map((e) => e.message.replace(/ \(rule.*$/, ""))).toEqual([
      "[perf-budget.durationMs] /cart :: load: durationMs=900 > budget 500",
      "[perf-budget.durationMs] /cart :: click #buy: durationMs=300 > budget 200",
      "[perf-budget.interactionMs] /cart :: click #buy: interactionMs=180 > budget 100",
    ]);
  });

  it("skips a metric the span did not measure instead of failing it", () => {
    // The load span has no interaction; paintMs exists only at trace level.
    expect(checkPerfBudgets([load], [{ match: "*", budget: { interactionMs: 0, paintMs: 0 } }], url)).toEqual([]);
  });
});

describe("perfBudgetRulesFromJson", () => {
  it("passes the array form through", () => {
    const rules = [{ match: "* :: load", budget: { durationMs: 1000 } }];
    expect(perfBudgetRulesFromJson(rules)).toBe(rules);
  });

  it("turns an emit-budgets file into one rule per key", () => {
    expect(
      perfBudgetRulesFromJson({
        version: 1,
        headroom: 1.25,
        budgets: { "/ :: load": { durationMs: 100 }, "/ :: click #a": { blockingMs: 0 } },
      }),
    ).toEqual([
      { match: "/ :: load", budget: { durationMs: 100 }, exact: true },
      { match: "/ :: click #a", budget: { blockingMs: 0 }, exact: true },
    ]);
  });

  it("matches emit-budgets keys literally, so a `*` in a selector budgets only its own key", () => {
    const rules = perfBudgetRulesFromJson({
      version: 1,
      budgets: {
        '/p :: click [class*="btn"]': { durationMs: 40 },
        '/p :: click [class^="btn"]': { durationMs: 400 },
      },
    });
    const span = (key: string, durationMs: number) => fakeSpan(key, { durationMs });
    // 100 ms on the ^= key is within its own 400 ms; as a glob, the *= key's
    // 40 ms would have matched it too.
    expect(checkPerfBudgets([span('/p :: click [class^="btn"]', 100)], rules, "u")).toEqual([]);
    expect(checkPerfBudgets([span('/p :: click [class*="btn"]', 100)], rules, "u")).toHaveLength(1);
  });

  it("prints a measured value that is over the limit, and folds it out of the cluster", () => {
    const rules = [{ match: "* :: load", budget: { requestCount: 20, encodedKB: 10 } }];
    const [a] = checkPerfBudgets([fakeSpan("/ :: load", { requestCount: 23 })], rules, "u");
    const [b] = checkPerfBudgets([fakeSpan("/ :: load", { requestCount: 24 })], rules, "u");
    expect(fingerprintError(a!)).toBe(fingerprintError(b!));
    const [c] = checkPerfBudgets([fakeSpan("/ :: load", { encodedKB: 10.4 })], rules, "u");
    expect(c!.message).toContain("encodedKB=10.4 > budget 10");
  });

  it("refuses other shapes and other versions", () => {
    expect(() => perfBudgetRulesFromJson({ durationMs: 1 }, "b.json")).toThrow(/b\.json: expected a perfBudgets array/);
    expect(() => perfBudgetRulesFromJson({ version: 2, budgets: {} })).toThrow(/version 2/);
    expect(() => perfBudgetRulesFromJson("x")).toThrow(/expected/);
  });
});

describe("perfBudgets validation", () => {
  const base: CrawlerOptions = { baseUrl: "http://localhost:3000" };

  it("accepts rules over lightbringer's budget metrics, 0 included", () => {
    expect(() =>
      validateOptions({ ...base, perfBudgets: [{ match: "*", budget: { durationMs: 100, requestCount: 0 } }] }),
    ).not.toThrow();
    // The accepted names are lightbringer's list, not a copy of it.
    const all = Object.fromEntries(Object.keys(BUDGET_METRIC).map((k) => [k, 1]));
    expect(() => validatePerfBudgets([{ match: "*", budget: all }])).not.toThrow();
  });

  it("refuses a malformed rule with the field it is about", () => {
    expect(() => validatePerfBudgets({})).toThrow(/"perfBudgets" must be an array/);
    expect(() => validatePerfBudgets([null])).toThrow(/"perfBudgets\[0\]" must be an object/);
    expect(() => validatePerfBudgets([{ match: "", budget: {} }])).toThrow(/perfBudgets\[0\]\.match/);
    expect(() => validatePerfBudgets([{ match: "*", budget: [] }])).toThrow(/perfBudgets\[0\]\.budget/);
    expect(() => validatePerfBudgets([{ match: "*", budget: {}, extra: 1 }])).toThrow(/not a rule field/);
    expect(() => validatePerfBudgets([{ match: "*", budget: { blockingMS: 1 } }])).toThrow(
      /"perfBudgets\[0\]\.budget\.blockingMS" is not a budget metric/,
    );
    expect(() => validatePerfBudgets([{ match: "*", budget: { durationMs: -1 } }])).toThrow(/non-negative/);
    expect(() => validatePerfBudgets([{ match: "*", budget: { durationMs: "1" } }])).toThrow(/non-negative/);
    expect(() => validatePerfBudgets([{ match: "*", budget: {}, exact: "yes" }])).toThrow(/\.exact" must be a boolean/);
    expect(() => validatePerfBudgets([{ match: "/ :: load", budget: {}, exact: true }])).not.toThrow();
  });

  it("refuses rules together with perf: false, which would pass without measuring", () => {
    expect(() =>
      validateOptions({ ...base, perf: false, perfBudgets: [{ match: "*", budget: { durationMs: 1 } }] }),
    ).toThrow(/"perfBudgets" needs per-step measurement/);
    expect(() => validateOptions({ ...base, perf: false, perfBudgets: [] })).not.toThrow();
  });
});

describe("repro command --perf* flags", () => {
  const repro = (o: Partial<CrawlerOptions>) =>
    buildReproCommand({ ...DEFAULT_OPTIONS, baseUrl: "http://x", ...o } as Required<CrawlerOptions>, 7);

  it("emits nothing with perf off", () => {
    expect(perfReproFlags({})).toEqual([]);
    expect(perfReproFlags({ perf: false })).toEqual([]);
    expect(repro({})).not.toContain("--perf");
  });

  it("emits --perf for the light level", () => {
    expect(perfReproFlags({ perf: true })).toEqual(["--perf"]);
    expect(perfReproFlags({ perf: {} })).toEqual(["--perf"]);
    expect(repro({ perf: true })).toMatch(/ --perf$/);
  });

  it("emits each option's flag, and no redundant --perf", () => {
    expect(
      perfReproFlags({ perf: { level: "trace", memory: { forceGc: true }, coverage: true, outDir: "out dir" } }),
    ).toEqual(["--perf-trace", "--perf-mem", "--perf-cov", "--perf-out", "'out dir'"]);
    // cssSelectorStats has no flag; it implies trace level, which does.
    expect(perfReproFlags({ perf: { cssSelectorStats: true } })).toEqual(["--perf-trace"]);
  });

  it("keeps --perf for budgets set in code, which have no file to point at", () => {
    expect(perfReproFlags({ perfBudgets: [{ match: "*", budget: { durationMs: 1 } }] })).toEqual(["--perf"]);
    expect(perfReproFlags({ perfBudgets: [] })).toEqual([]);
  });

  it("points back at the --perf-budgets file", () => {
    const perfBudgets = [{ match: "*", budget: { durationMs: 1 } }];
    expect(perfReproFlags({ perfBudgetsFile: "b.json" })).toEqual(["--perf-budgets", "b.json"]);
    expect(perfReproFlags({ perf: true, perfBudgets, perfBudgetsFile: "b.json" })).toEqual([
      "--perf-budgets",
      "b.json",
    ]);
    expect(perfReproFlags({ perf: { outDir: "o" }, perfBudgetsFile: "b.json" })).toEqual([
      "--perf-out",
      "o",
      "--perf-budgets",
      "b.json",
    ]);
  });

  it("keeps --perf when the budgets file has no rules, which do not turn perf on", () => {
    expect(perfReproFlags({ perf: true, perfBudgets: [], perfBudgetsFile: "empty.json" })).toEqual([
      "--perf",
      "--perf-budgets",
      "empty.json",
    ]);
  });
});
