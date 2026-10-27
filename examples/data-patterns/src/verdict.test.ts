import type { CrawlReport } from "chaosbringer";
import { describe, expect, it } from "vitest";
import type { DataPattern, Injection, PatternExpect } from "./pattern.js";
import { type CaseRun, deliveredOf, judgeBuggy, judgeClean, judgeDelivered, signalsOf } from "./verdict.js";

const ORIGIN = "http://127.0.0.1:5000";
const SUITE = ["data.xss-marker", "data.injected-markup", "data.prototype-pollution", "data.rendered-garbage", "data.not-blank"];

const pattern = (
  expect: PatternExpect = { signal: { kind: "error", message: /Cannot read properties of null/ } },
  inject: Injection = { channel: "response", path: "/api/user", bad: "{}", benign: "{}" },
): DataPattern => ({
  id: "p",
  title: "t",
  category: expect.signal === "none" ? "oracle" : "bug-data",
  description: "d",
  fix: "f",
  realism: "r",
  routes: () => ({}),
  inject,
  expect,
});

type Cluster = CrawlReport["errorClusters"][number];

const cluster = (type: Cluster["type"], message: string, invariantNames?: string[]): Cluster => ({
  key: `${type}|${message}`,
  type,
  fingerprint: message,
  sample: { type, message, url: `${ORIGIN}/`, timestamp: 0 },
  count: 1,
  urls: [`${ORIGIN}/`],
  ...(invariantNames ? { invariantNames } : {}),
});

/** A one-page report; only the fields the verdicts read. */
function report(over: Partial<CrawlReport> = {}, page: Partial<CrawlReport["pages"][number]> = {}): CrawlReport {
  return {
    pages: [{ url: `${ORIGIN}/`, status: "success", loadTime: 1, errors: [], hasErrors: false, warnings: [], links: [], ...page }],
    actions: [],
    errorClusters: [],
    ...over,
  } as unknown as CrawlReport;
}

function run(r: CrawlReport, over: Partial<CaseRun> = {}): CaseRun {
  return {
    variant: "buggy",
    data: "bad",
    entryUrl: `${ORIGIN}/`,
    report: r,
    exitCode: 0,
    defaultExit: 0,
    signals: signalsOf(r),
    delivered: 1,
    invariantRuns: Object.fromEntries(SUITE.map((n) => [n, 1])),
    ...over,
  };
}

const NULL_READ = "Cannot read properties of null (reading 'name')";

describe("signalsOf", () => {
  it("reads errors, failed invariants and blocked navigations", () => {
    const r = report(
      {
        errorClusters: [
          cluster("unhandled-rejection", NULL_READ),
          cluster("invariant-violation", "[data.xss-marker] XSS marker set: window.__cb_xss_fired", ["data.xss-marker"]),
        ],
      },
      { blockedNavigations: ["http://localhost:4001/cb-offsite-marker"] },
    );
    expect(signalsOf(r)).toEqual([
      { kind: "error", type: "unhandled-rejection", message: NULL_READ },
      { kind: "invariant", name: "data.xss-marker", messages: ["XSS marker set: window.__cb_xss_fired"] },
      { kind: "blocked-navigation", url: "http://localhost:4001/cb-offsite-marker" },
    ]);
  });

  it("leaves out the browser's error page for a blocked navigation", () => {
    const r = report({}, { blockedNavigations: ["http://localhost:4001/cb-offsite-marker", "chrome-error://chromewebdata/"] });
    expect(signalsOf(r)).toEqual([{ kind: "blocked-navigation", url: "http://localhost:4001/cb-offsite-marker" }]);
    expect(signalsOf(report({}, { blockedNavigations: ["chrome-error://chromewebdata/"] }))).toEqual([]);
  });

  it("lists an invariant once however many clusters it failed in, with each message", () => {
    const r = report({
      errorClusters: [
        cluster("invariant-violation", "[data.rendered-garbage] rendered garbage: NaN", ["data.rendered-garbage"]),
        cluster("invariant-violation", "[data.rendered-garbage] rendered garbage: undefined", ["data.rendered-garbage"]),
      ],
    });
    expect(signalsOf(r)).toEqual([
      { kind: "invariant", name: "data.rendered-garbage", messages: ["rendered garbage: NaN", "rendered garbage: undefined"] },
    ]);
  });
});

describe("judgeBuggy", () => {
  it("passes on the expected signal and a failing strict exit", () => {
    const r = report({ errorClusters: [cluster("unhandled-rejection", NULL_READ)] });
    expect(judgeBuggy(pattern(), run(r, { exitCode: 1 }))).toEqual([]);
  });

  it("fails when the signal is missing, and says what was seen", () => {
    const r = report({ errorClusters: [cluster("exception", "x is not a function")] });
    const problems = judgeBuggy(pattern(), run(r, { exitCode: 1 }));
    expect(problems).toContain('expected error /Cannot read properties of null/, saw exception "x is not a function"');
    expect(problems).toContain('undeclared signal: exception "x is not a function"');
    expect(judgeBuggy(pattern(), run(report(), { exitCode: 1 }))[0]).toMatch(/saw nothing/);
  });

  it("fails an error or invariant signal whose strict exit is 0", () => {
    const r = report({ errorClusters: [cluster("unhandled-rejection", NULL_READ)] });
    expect(judgeBuggy(pattern(), run(r, { exitCode: 0 }))).toEqual(["strict exit code 0, expected 1"]);
    const inv = report({ errorClusters: [cluster("invariant-violation", "[data.not-blank] blank", ["data.not-blank"])] });
    const p = pattern({ signal: { kind: "invariant", name: "data.not-blank" } });
    expect(judgeBuggy(p, run(inv, { exitCode: 1 }))).toEqual([]);
    expect(judgeBuggy(p, run(inv, { exitCode: 0 }))).toEqual(["strict exit code 0, expected 1"]);
  });

  it("does not hold a blocked navigation to an exit code", () => {
    const r = report({}, { blockedNavigations: ["http://localhost:4001/cb-offsite-marker", "chrome-error://chromewebdata/"] });
    const p = pattern({ signal: { kind: "blocked-navigation", includes: "/cb-offsite-marker" } });
    expect(judgeBuggy(p, run(r, { exitCode: 0 }))).toEqual([]);
    expect(judgeBuggy(p, run(report(), { exitCode: 0 }))).toEqual(["expected blocked navigation to */cb-offsite-marker*, saw nothing"]);
  });

  it("holds the run to exactly the signal plus alsoSignals", () => {
    const both = report({
      errorClusters: [cluster("unhandled-rejection", NULL_READ), cluster("invariant-violation", "[data.not-blank] blank", ["data.not-blank"])],
    });
    // Undeclared: the extra invariant fails the verdict.
    expect(judgeBuggy(pattern(), run(both, { exitCode: 1 }))).toEqual(['undeclared signal: invariant data.not-blank "blank"']);
    // Declared: passes.
    const declared = pattern({
      signal: { kind: "error", message: /Cannot read properties of null/ },
      alsoSignals: [{ kind: "invariant", name: "data.not-blank" }],
    });
    expect(judgeBuggy(declared, run(both, { exitCode: 1 }))).toEqual([]);
    // Declared but missing: fails too.
    const only = report({ errorClusters: [cluster("unhandled-rejection", NULL_READ)] });
    expect(judgeBuggy(declared, run(only, { exitCode: 1 }))).toEqual([
      `expected invariant data.not-blank, saw unhandled-rejection "${NULL_READ}"`,
    ]);
  });

  it("matches an invariant's message when the signal names one", () => {
    const polluted = (message: string) =>
      report({ errorClusters: [cluster("invariant-violation", `[data.prototype-pollution] ${message}`, ["data.prototype-pollution"])] });
    const p = pattern({ signal: { kind: "invariant", name: "data.prototype-pollution", message: /cbPolluted/ } });
    expect(judgeBuggy(p, run(polluted("Object.prototype polluted: cbPolluted"), { exitCode: 1 }))).toEqual([]);
    expect(judgeBuggy(p, run(polluted("Object.prototype polluted: isAdmin"), { exitCode: 1 }))).toEqual([
      'expected invariant data.prototype-pollution /cbPolluted/, saw invariant data.prototype-pollution "Object.prototype polluted: isAdmin"',
      'undeclared signal: invariant data.prototype-pollution "Object.prototype polluted: isAdmin"',
    ]);
    // Without a message, any failure of the invariant matches.
    const any = pattern({ signal: { kind: "invariant", name: "data.prototype-pollution" } });
    expect(judgeBuggy(any, run(polluted("Object.prototype polluted: isAdmin"), { exitCode: 1 }))).toEqual([]);
  });

  it("matches a global regex on every call", () => {
    const p = pattern({ signal: { kind: "error", message: /reading 'name'/g } });
    const r = run(report({ errorClusters: [cluster("unhandled-rejection", NULL_READ)] }), { exitCode: 1 });
    expect(judgeBuggy(p, r)).toEqual([]);
    expect(judgeBuggy(p, r)).toEqual([]);
  });

  it("has nothing to flag on an oracle entry", () => {
    expect(judgeBuggy(pattern({ signal: "none" }, { channel: "none" }), run(report()))).not.toEqual([]);
  });
});

describe("judgeClean", () => {
  const p = pattern();

  it("passes a run with no signal, strict exit 0, a loaded page and every check run", () => {
    expect(judgeClean(p, run(report()))).toEqual([]);
  });

  it("fails on any signal, of any kind", () => {
    expect(judgeClean(p, run(report({ errorClusters: [cluster("console", "oops")] })))).toEqual(['reported console "oops"']);
    expect(judgeClean(p, run(report({ errorClusters: [cluster("invariant-violation", "[data.xss-marker] x", ["data.xss-marker"])] })))).toEqual([
      'reported invariant data.xss-marker "x"',
    ]);
    expect(judgeClean(p, run(report({}, { blockedNavigations: ["http://localhost:4001/x"] })))).toEqual([
      "reported blocked navigation to http://localhost:4001/x",
    ]);
  });

  it("is not failed by the browser's error page alone", () => {
    expect(judgeClean(p, run(report({}, { blockedNavigations: ["chrome-error://chromewebdata/"] })))).toEqual([]);
  });

  it("fails a strict exit of 1, a page that did not load, or no page at all", () => {
    expect(judgeClean(p, run(report(), { exitCode: 1 }))).toEqual(["strict exit code 1, expected 0"]);
    expect(judgeClean(p, run(report({}, { status: "error" })))).toEqual([`page ${ORIGIN}/ has status "error"`]);
    expect(judgeClean(p, run(report({ pages: [] })))).toEqual(["no page was visited"]);
  });

  it("fails when a suite invariant never ran", () => {
    const runs = { ...Object.fromEntries(SUITE.map((n) => [n, 1])), "data.not-blank": 0 };
    expect(judgeClean(p, run(report(), { invariantRuns: runs }))).toEqual(["invariant data.not-blank never ran"]);
    expect(judgeClean(p, run(report(), { invariantRuns: {} }))).toEqual(["no invariant was counted"]);
  });
});

describe("judgeDelivered", () => {
  it("response: the data:<path> rule injected at least once", () => {
    const p = pattern();
    const stats = (matched: number, injected: number) => report({ faultInjections: [{ rule: "data:/api/user", matched, injected }] });
    expect(judgeDelivered(p, run(stats(1, 1)))).toEqual([]);
    expect(deliveredOf(p, stats(2, 2), `${ORIGIN}/`)).toBe(2);
    expect(judgeDelivered(p, run(stats(0, 0)))).toEqual(["rule data:/api/user never matched: the page did not fetch /api/user"]);
    expect(judgeDelivered(p, run(stats(2, 0)))).toEqual(["rule data:/api/user matched 2 times and injected none"]);
    // Another rule's injections don't count.
    expect(judgeDelivered(p, run(report({ faultInjections: [{ rule: "data:/api/users", matched: 1, injected: 1 }] })))).not.toEqual([]);
  });

  it("storage: the data:<key> fault fired at least once", () => {
    const p = pattern(undefined, { channel: "storage", key: "prefs", bad: "{bad", benign: "{}" });
    const fired = (n: number) => report({ lifecycleFaults: [{ name: "data:prefs", matched: 1, fired: n, errored: 0 }] });
    expect(judgeDelivered(p, run(fired(1)))).toEqual([]);
    expect(judgeDelivered(p, run(fired(0)))).toEqual(["lifecycle fault data:prefs never fired"]);
    expect(judgeDelivered(p, run(report()))).toEqual(["lifecycle fault data:prefs never fired"]);
  });

  it("query: a visited page carries the entry URL's query", () => {
    const p = pattern(undefined, { channel: "query", bad: "?q=%3Cb%3E", benign: "?q=shoes" });
    const entryUrl = `${ORIGIN}/search?q=%3Cb%3E`;
    expect(judgeDelivered(p, run(report({}, { url: entryUrl }), { entryUrl }))).toEqual([]);
    expect(judgeDelivered(p, run(report({}, { url: `${ORIGIN}/search` }), { entryUrl }))).toEqual([
      `no visited page carries the query of ${entryUrl}`,
    ]);
    // An entry URL with no query delivered nothing, whatever was visited.
    expect(judgeDelivered(p, run(report({}, { url: `${ORIGIN}/search` }), { entryUrl: `${ORIGIN}/search` }))).not.toEqual([]);
  });

  it("form: an input action that succeeded", () => {
    const p = pattern(undefined, { channel: "form", bad: "<b>", benign: "hello" });
    const actions = (...a: Array<{ type: string; success: boolean }>) => report({ actions: a.map((x) => ({ ...x, timestamp: 0 })) as CrawlReport["actions"] });
    expect(judgeDelivered(p, run(actions({ type: "input", success: true })))).toEqual([]);
    expect(judgeDelivered(p, run(actions({ type: "input", success: false }), {}))).toEqual([
      "no form fill succeeded: the driver never put the value in the page",
    ]);
    expect(judgeDelivered(p, run(actions({ type: "click", success: true })))).not.toEqual([]);
  });

  it("none: nothing to deliver", () => {
    expect(judgeDelivered(pattern({ signal: "none" }, { channel: "none" }), run(report()))).toEqual([]);
  });
});
