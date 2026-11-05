import { describe, expect, it } from "vitest";
import { CRAWL_CLI_OPTIONS } from "./cli-crawl-options.js";
import { compileFaultRules, faultStatsOf } from "./fault-router.js";
import { faults } from "./faults.js";
import { buildReproCommand, formatReproFlags, shellQuote, unreplayedNote } from "./repro-command.js";
import { cliOptions, comparable, resolved, ROUND_TRIPS, shellWords, URL } from "./repro-flags.test-helpers.js";
import type { CrawlerOptions } from "./types.js";

/**
 * Flags a repro leaves out on purpose, with why. Each only changes what the
 * run writes or shows, not what it does or how it exits.
 */
const LEFT_OUT: Record<string, string> = {
  headless: "the reader decides whether to watch the window; the crawl is the same",
  "no-headless": "the reader decides whether to watch the window; the crawl is the same",
  screenshots: "writes files",
  "screenshot-dir": "writes files",
  output: "where the report is written",
  "log-file": "logging",
  "log-level": "logging",
  "log-console": "logging",
  "har-record": "writes a HAR; a repro would overwrite the run's",
  bind: "lets other clients watch the browser",
  "bind-title": "lets other clients watch the browser",
  "visual-diff-dir": "writes diff images",
  "visual-update": "rewrites the baselines the repro has to compare against",
  "failure-artifacts": "writes bundles",
  "failure-max": "writes bundles",
  "cluster-artifacts": "writes bundles",
  "cluster-min-count": "writes bundles",
  // A diff against another run's report, usually a CI download the repro
  // machine does not have; the repro reproduces the run's own failures.
  baseline: "compares against another report",
  "baseline-strict": "compares against another report",
  "baseline-missing": "compares against another report",
  "github-annotations": "output format",
  heatmap: "output format",
  "heatmap-top": "output format",
  "heatmap-out": "writes a file",
  junit: "writes a file",
  compact: "output format",
  quiet: "output format",
  help: "not a run",
  version: "not a run",
};

describe("reproCommand covers the main CLI's flags", () => {
  it("names every flag of the CLI's table exactly once, and nothing else", () => {
    const flags = Object.keys(CRAWL_CLI_OPTIONS).sort();
    const listed = [...Object.keys(ROUND_TRIPS), ...Object.keys(LEFT_OUT)].sort();
    expect(listed).toEqual(flags);
  });

  const base = comparable(resolved(cliOptions(["--url", URL])));

  it.each(Object.entries(ROUND_TRIPS))("--%s round-trips", (flag, argv) => {
    expect(argv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`))).toBe(true);
    const before = resolved(cliOptions(["--url", URL, ...argv]));
    // A sample that changed nothing would pass without testing anything.
    expect(comparable(before)).not.toEqual(base);

    const command = buildReproCommand(before, before.seed);
    // The --axe / --visual-* invariants are the flags': nothing is left to note.
    expect(unreplayedNote(before)).toBeUndefined();
    const words = shellWords(command);
    expect(words[0]).toBe("chaosbringer");
    // parseArgs is strict: an unknown or malformed flag throws here.
    const after = resolved(cliOptions(words.slice(1)));
    expect(comparable(after)).toEqual(comparable(before));
    expect(buildReproCommand(after, after.seed)).toBe(command);
  });
});

describe("reproCommand of --invariants / --data-safety", () => {
  const invariantNames = (o: CrawlerOptions) => (o.invariants ?? []).map((i) => i.name);

  it.each([
    [["--data-safety"], "--invariants data-safety"],
    [["--invariants", "data-safety,xss-marker,rendered-garbage"], "--invariants data-safety"],
    [["--invariants", "not-blank", "--data-safety"], "--invariants data-safety,not-blank"],
    [["--invariants", "rendered-garbage,xss-marker"], "--invariants xss-marker,rendered-garbage"],
    // The alias is written as the flag it stands for, with its tags.
    [["--invariants", "axe,not-blank", "--axe-tags", "wcag2a"], "--axe --axe-tags wcag2a --invariants not-blank"],
  ])("%j reruns with the same invariants: %s", (argv, flags) => {
    const before = resolved(cliOptions(["--url", URL, ...argv]));
    const command = buildReproCommand(before, 1);
    expect(command).toBe(`chaosbringer --url ${URL} --seed 1 ${flags}`);
    // What the flag built is the flag's, not "not expressible on the CLI".
    expect(unreplayedNote(before)).toBeUndefined();
    const after = resolved(cliOptions(shellWords(command).slice(1)));
    expect(invariantNames(after)).toEqual(invariantNames(before));
    expect(invariantNames(after).length).toBeGreaterThan(0);
  });

  it("still notes an invariant set in code next to them", () => {
    const o = resolved({ ...cliOptions(["--url", URL, "--data-safety"]) });
    o.invariants = [...o.invariants, { name: "cart-total", check: () => true }];
    expect(buildReproCommand(o, 1)).toBe(
      `chaosbringer --url ${URL} --seed 1 --invariants data-safety # + 1 invariant not expressible on the CLI: cart-total`,
    );
  });
});

describe("reproCommand of a run with faults and invariants set in code", () => {
  const plain = ["chaosbringer", "--url", URL, "--seed", "1"];

  it("ends in a comment that counts and names them, which a shell skips", () => {
    // What scan's 500 crawl set: its repro reran clean and passed, and said nothing.
    const o = resolved({ baseUrl: URL, faultInjection: [faults.status(500, { urlPattern: "/api/", name: "scan:api-500" })] });
    const command = buildReproCommand(o, 1);
    expect(command).toBe(`chaosbringer --url ${URL} --seed 1 # + 1 fault rule not expressible on the CLI: scan:api-500`);
    expect(shellWords(command)).toEqual(plain);
  });

  it("covers every fault layer and the invariants no flag built", () => {
    const o = resolved({
      ...cliOptions(["--url", URL, "--axe"]),
      faultInjection: [faults.abort({ urlPattern: /\/api\/(cart|items)/ })],
      lifecycleFaults: [faults.cpu(4)],
      runtimeFaults: [faults.rejectBody({ urlPattern: "/api/" })],
      iframeFaults: [faults.iframeNeverLoad({ selector: "iframe" })],
      invariants: [...(cliOptions(["--url", URL, "--axe"]).invariants ?? []), { name: "cart-total", check: () => true }],
    });
    const command = buildReproCommand(o, 1);
    expect(command).toBe(
      `chaosbringer --url ${URL} --seed 1 --axe # + 1 fault rule, 1 lifecycle fault, 1 runtime fault, 1 iframe fault, 1 invariant ` +
        `not expressible on the CLI: '/\\/api\\/(cart|items)/', cpu-throttle:4x, reject-body:json, iframe-never-load, cart-total`,
    );
    expect(shellWords(command)).toEqual([...plain, "--axe"]);
  });

  // The note named it "/api/" and the stats `/\/api\//`, so the two did not
  // read as the same rule.
  it("names an unnamed rule with a string pattern as its stats do", () => {
    const rules = [faults.status(500, { urlPattern: "/api/" }), faults.abort({ urlPattern: /\/img\//g })];
    const stats = faultStatsOf(compileFaultRules(rules)).map((s) => s.rule);
    expect(stats).toEqual(["/\\/api\\//", "/\\/img\\//"]);
    expect(unreplayedNote({ faultInjection: rules })).toBe(
      `2 fault rules not expressible on the CLI: ${stats.map(shellQuote).join(", ")}`,
    );
  });

  it("keeps a name a shell would act on inside the comment", () => {
    const o = resolved({
      baseUrl: URL,
      invariants: [1, 2, 3, 4, 5].map((i) => ({ name: `inv-${i}`, check: () => true })),
      faultInjection: [faults.status(500, { urlPattern: "/x", name: "x\necho INJECTED; $(echo also)" })],
    });
    const command = buildReproCommand(o, 1);
    expect(command).not.toContain("\n");
    // The rule's name first, then five names and the count of the rest.
    expect(command).toMatch(/: 'x echo INJECTED; \$\(echo also\)', inv-1, inv-2, inv-3, inv-4, \+1 more$/);
    expect(shellWords(command)).toEqual(plain);
  });

  it("says nothing for a run with none", () => {
    expect(buildReproCommand(resolved({ baseUrl: URL }), 1)).toBe(`chaosbringer --url ${URL} --seed 1`);
  });
});

describe("shellQuote", () => {
  it("leaves plain words alone", () => {
    for (const s of ["http://127.0.0.1:4455/a/b.html", "ttfb=200,lcp=2500", "1/3", "a@b%c+d"]) {
      expect(shellQuote(s)).toBe(s);
    }
  });

  it("quotes what a shell would expand or split", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("Pixel 7")).toBe("'Pixel 7'");
    expect(shellQuote("/a?b")).toBe("'/a?b'");
    expect(shellQuote("/a&b")).toBe("'/a&b'");
    expect(shellQuote("=x")).toBe("'=x'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("joins a value starting with - to its flag", () => {
    expect(formatReproFlags([{ flag: "--exclude", value: "-x y" }, { flag: "--strict" }])).toEqual([
      "--exclude='-x y'",
      "--strict",
    ]);
  });
});
