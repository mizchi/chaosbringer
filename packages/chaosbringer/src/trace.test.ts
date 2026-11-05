import { describe, expect, it } from "vitest";
import { cliOptions, URL } from "./repro-flags.test-helpers.js";
import {
  TRACE_FORMAT_VERSION,
  actionToTraceEntry,
  groupTrace,
  metaOf,
  parseTrace,
  serializeTrace,
  traceSetupFlags,
  traceSetupOf,
  type TraceEntry,
} from "./trace.js";
import type { ActionResult } from "./types.js";

const META: TraceEntry = {
  kind: "meta",
  v: TRACE_FORMAT_VERSION,
  seed: 42,
  baseUrl: "http://x/",
  startTime: 0,
};

describe("actionToTraceEntry", () => {
  it("copies optional fields only when set", () => {
    const action: ActionResult = {
      type: "click",
      target: "Home",
      selector: "a[href='/']",
      success: true,
      timestamp: 123,
    };
    expect(actionToTraceEntry(action, "http://x/")).toEqual({
      kind: "action",
      url: "http://x/",
      type: "click",
      target: "Home",
      selector: "a[href='/']",
      success: true,
    });
  });

  it("drops undefined optional fields", () => {
    const action: ActionResult = {
      type: "scroll",
      target: "scrollY: 200",
      success: true,
      timestamp: 0,
    };
    const entry = actionToTraceEntry(action, "http://x/");
    expect(entry).not.toHaveProperty("selector");
    expect(entry).not.toHaveProperty("error");
    expect(entry).not.toHaveProperty("blockedExternal");
  });
});

describe("serializeTrace / parseTrace", () => {
  it("round-trips a simple trace", () => {
    const entries: TraceEntry[] = [
      META,
      { kind: "visit", url: "http://x/" },
      {
        kind: "action",
        url: "http://x/",
        type: "click",
        target: "Home",
        selector: "a",
        success: true,
      },
    ];
    const parsed = parseTrace(serializeTrace(entries));
    expect(parsed).toEqual(entries);
  });

  it("rejects a serialize call that lacks a leading meta", () => {
    expect(() => serializeTrace([{ kind: "visit", url: "http://x/" }])).toThrow(/meta/);
  });

  it("ignores blank lines but rejects malformed JSON", () => {
    const ok = `${JSON.stringify(META)}\n\n${JSON.stringify({ kind: "visit", url: "/" })}\n`;
    expect(parseTrace(ok)).toHaveLength(2);

    const bad = `${JSON.stringify(META)}\nnot-json\n`;
    expect(() => parseTrace(bad)).toThrow(/line 2/);
  });

  it("rejects entries with unknown kinds", () => {
    const raw = `${JSON.stringify(META)}\n${JSON.stringify({ kind: "oops" })}\n`;
    expect(() => parseTrace(raw)).toThrow(/unknown kind/);
  });

  it("rejects traces missing the leading meta", () => {
    expect(() => parseTrace(`${JSON.stringify({ kind: "visit", url: "/" })}\n`)).toThrow(/meta/);
  });

  it("rejects traces with an unsupported format version", () => {
    const wrong = { ...META, v: TRACE_FORMAT_VERSION + 99 };
    expect(() => parseTrace(`${JSON.stringify(wrong)}\n`)).toThrow(
      `unsupported trace format v=${TRACE_FORMAT_VERSION + 99} (this build understands v=1, v=2)`,
    );
  });

  it("still reads a v1 trace, which has no setup", () => {
    const v1 = { kind: "meta", v: 1, seed: 1, baseUrl: "http://x/", startTime: 0 };
    const [meta] = parseTrace(`${JSON.stringify(v1)}\n${JSON.stringify({ kind: "visit", url: "http://x/" })}\n`);
    expect(meta).toEqual(v1);
  });
});

describe("traceSetupOf", () => {
  const setup = (argv: string[]) => traceSetupOf(cliOptions(["--url", URL, ...argv]));

  it("records nothing for a crawl with the defaults", () => {
    expect(setup([])).toBeUndefined();
    // What a replay does not read, or a trace decides itself.
    expect(setup(["--seed", "3", "--max-actions", "2", "--max-pages", "4", "--strict", "--trace-out", "t.jsonl"])).toBeUndefined();
  });

  it("records the options that change how a replay loads, settles and judges its pages", () => {
    expect(
      setup([
        "--timeout", "5000", "--settle", "250", "--exclude", "/logout", "--ignore-preset", "analytics",
        "--ignore-error", "noise", "--ignore-http", "/favicon", "--spa", "/app", "--storage-state", "auth.json",
        "--har-replay", "net.har", "--device", "Pixel 7", "--network", "slow-3g", "--no-http-cache",
        "--data-safety", "--axe", "--axe-tags", "wcag2a",
      ]),
    ).toEqual({
      timeout: 5000,
      settle: 250,
      excludePatterns: ["/logout"],
      ignoreErrorPatterns: ["noise", ...cliOptions(["--url", URL, "--ignore-preset", "analytics"]).ignoreErrorPatterns!],
      ignoreHttpPatterns: ["/favicon"],
      spaPatterns: ["/app"],
      storageState: "auth.json",
      harReplay: "net.har",
      device: "Pixel 7",
      network: "slow-3g",
      httpCache: false,
      invariants: "data-safety",
      axe: { tags: "wcag2a" },
    });
  });

  it("records a file's path, never what is in it, and not a HAR it records", () => {
    expect(setup(["--storage-state", "secrets/auth.json"])).toEqual({ storageState: "secrets/auth.json" });
    expect(setup(["--har-record", "out.har"])).toBeUndefined();
  });

  it("round-trips through the crawl flags it is printed as", () => {
    const argv = ["--settle", "adaptive", "--exclude=-x", "--ignore-analytics", "--ignore-error", "x", "--invariants", "not-blank"];
    const recorded = setup(argv);
    const flags = traceSetupFlags(recorded).flatMap(({ flag, value }) =>
      value === undefined ? [flag] : value.startsWith("-") ? [`${flag}=${value}`] : [flag, value],
    );
    expect(traceSetupOf(cliOptions(["--url", URL, ...flags]))).toEqual(recorded);
    expect(flags).toEqual([
      "--settle", "adaptive", "--exclude=-x", "--ignore-error", "x", "--ignore-analytics", "--invariants", "not-blank",
    ]);
  });
});

describe("groupTrace", () => {
  it("splits actions by their preceding visit", () => {
    const groups = groupTrace([
      META,
      { kind: "visit", url: "http://x/a" },
      { kind: "action", url: "http://x/a", type: "click", success: true },
      { kind: "action", url: "http://x/a", type: "scroll", success: true },
      { kind: "visit", url: "http://x/b" },
      { kind: "action", url: "http://x/b", type: "input", success: true },
    ]);
    expect(groups).toEqual([
      {
        url: "http://x/a",
        actions: [
          { kind: "action", url: "http://x/a", type: "click", success: true },
          { kind: "action", url: "http://x/a", type: "scroll", success: true },
        ],
      },
      {
        url: "http://x/b",
        actions: [{ kind: "action", url: "http://x/b", type: "input", success: true }],
      },
    ]);
  });

  it("ignores actions that appear before any visit", () => {
    const groups = groupTrace([
      META,
      { kind: "action", url: "http://x/?", type: "click", success: true },
      { kind: "visit", url: "http://x/a" },
    ]);
    expect(groups).toEqual([{ url: "http://x/a", actions: [] }]);
  });
});

describe("metaOf", () => {
  it("returns the first entry when it is a meta", () => {
    expect(metaOf([META])).toBe(META);
  });

  it("throws when the trace is empty or starts with something else", () => {
    expect(() => metaOf([])).toThrow(/meta/);
    expect(() => metaOf([{ kind: "visit", url: "/" } as TraceEntry])).toThrow(/meta/);
  });
});
