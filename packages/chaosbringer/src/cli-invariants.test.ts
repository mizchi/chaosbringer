/**
 * `--invariants <names>` / `--data-safety`, in process: the name table, how
 * a list is read, and what the main crawl and `scan` build from it. What
 * cli.ts does with the `UsageError` (one line, exit 2) is a row in
 * cli.test.ts; that a Repro line carries the flag back is in
 * repro-command.test.ts and scan/scan-repro.test.ts.
 */
import { describe, expect, it } from "vitest";
import { crawlCliPeerNeeds, crawlerOptionsFromCli, parseCrawlArgs } from "./cli-crawl-options.js";
import {
  buildInvariantPresets,
  DATA_SAFETY_PRESETS,
  expandInvariantNames,
  formatInvariantsFlag,
  INVARIANT_FLAG_NAMES,
  INVARIANT_PRESETS,
  invariantsFlagBuilds,
  parseInvariantsFlag,
} from "./cli-invariants.js";
import { UsageError } from "./cli-usage.js";
import { dataSafety, notBlank } from "./data-invariants.js";
import { parseScanArgs, scanOptionsFromCli } from "./scan/cli.js";
import { AXE_PEERS } from "./peers.js";

const URL = "http://127.0.0.1:4455/";

const crawl = (argv: string[]) => {
  const { values } = parseCrawlArgs(["--url", URL, ...argv]);
  return crawlerOptionsFromCli(values, URL);
};
const names = (argv: string[]) => (crawl(argv).invariants ?? []).map((i) => i.name);
const scan = (argv: string[]) => scanOptionsFromCli(parseScanArgs(["--url", URL, ...argv]).values);

const DATA_SAFETY_NAMES = dataSafety().map((i) => i.name);

describe("the --invariants name table", () => {
  it("builds each preset under its data.* name, with the defaults", () => {
    expect(buildInvariantPresets(INVARIANT_PRESETS).map((i) => i.name)).toEqual([...DATA_SAFETY_NAMES, notBlank().name]);
  });

  it("is dataSafety()'s four presets for data-safety, without notBlank", () => {
    expect(buildInvariantPresets(DATA_SAFETY_PRESETS).map((i) => i.name)).toEqual(DATA_SAFETY_NAMES);
    expect(DATA_SAFETY_PRESETS).not.toContain("not-blank");
  });

  it("lists every name the flag takes, axe as the --axe alias last", () => {
    expect(INVARIANT_FLAG_NAMES).toEqual([
      "data-safety",
      "xss-marker",
      "injected-markup",
      "prototype-pollution",
      "rendered-garbage",
      "not-blank",
      "axe",
    ]);
  });
});

describe("parseInvariantsFlag", () => {
  it("reads comma lists from every --invariants, merged, in the table's order", () => {
    expect(parseInvariantsFlag(["not-blank, xss-marker", "rendered-garbage"])).toEqual({
      presets: ["xss-marker", "rendered-garbage", "not-blank"],
      axe: false,
    });
  });

  it("registers a preset once however often it is named", () => {
    expect(parseInvariantsFlag(["xss-marker,xss-marker", "xss-marker"]).presets).toEqual(["xss-marker"]);
    // A member of the bundle named beside it.
    expect(parseInvariantsFlag(["data-safety,xss-marker", "rendered-garbage"]).presets).toEqual(DATA_SAFETY_PRESETS);
    // --data-safety is `--invariants data-safety`.
    expect(parseInvariantsFlag(["data-safety"], true).presets).toEqual(DATA_SAFETY_PRESETS);
    expect(parseInvariantsFlag(["not-blank"], true).presets).toEqual([...DATA_SAFETY_PRESETS, "not-blank"]);
  });

  it("reads axe as --axe, not as a preset", () => {
    expect(parseInvariantsFlag(["axe,not-blank"])).toEqual({ presets: ["not-blank"], axe: true });
  });

  it("is nothing without the flags", () => {
    expect(parseInvariantsFlag(undefined)).toEqual({ presets: [], axe: false });
  });

  it.each([
    [["nope"], '--invariants: unknown invariant "nope" (known: data-safety, xss-marker, injected-markup, prototype-pollution, rendered-garbage, not-blank, axe)'],
    // A preset's own `data.*` name is what the report shows, not what the flag takes.
    [["data.xss-marker"], '--invariants: unknown invariant "data.xss-marker" (known: data-safety, xss-marker, injected-markup, prototype-pollution, rendered-garbage, not-blank, axe)'],
    [["xss-marker,Not-Blank"], '--invariants: unknown invariant "Not-Blank" (known: data-safety, xss-marker, injected-markup, prototype-pollution, rendered-garbage, not-blank, axe)'],
    // `--invariants "$CHECKS"` with CHECKS unset ran with nothing.
    [[""], "--invariants needs at least one name (known: data-safety, xss-marker, injected-markup, prototype-pollution, rendered-garbage, not-blank, axe)"],
    [[" , "], "--invariants needs at least one name (known: data-safety, xss-marker, injected-markup, prototype-pollution, rendered-garbage, not-blank, axe)"],
  ])("refuses %j as a usage error", (raw, message) => {
    expect(() => parseInvariantsFlag(raw)).toThrow(UsageError);
    expect(() => parseInvariantsFlag(raw)).toThrow(message);
  });
});

describe("formatInvariantsFlag", () => {
  it("writes the bundle as data-safety, and the rest by name", () => {
    expect(formatInvariantsFlag(DATA_SAFETY_PRESETS)).toBe("data-safety");
    expect(formatInvariantsFlag([...DATA_SAFETY_PRESETS, "not-blank"])).toBe("data-safety,not-blank");
    expect(formatInvariantsFlag(["rendered-garbage", "xss-marker"])).toBe("xss-marker,rendered-garbage");
  });

  it("reads back as what it was written from", () => {
    for (const presets of [["not-blank"], DATA_SAFETY_PRESETS, INVARIANT_PRESETS, ["injected-markup", "prototype-pollution"]] as const) {
      expect(parseInvariantsFlag([formatInvariantsFlag(presets)]).presets).toEqual(expandInvariantNames(presets));
    }
  });

  it("names the invariants a value of the flag builds", () => {
    expect(invariantsFlagBuilds("data-safety,not-blank")).toEqual([...DATA_SAFETY_NAMES, "data.not-blank"]);
  });
});

describe("expandInvariantNames (ScanOptions.invariants)", () => {
  it("takes the bundle and the presets by name", () => {
    expect(expandInvariantNames(["not-blank", "data-safety"])).toEqual([...DATA_SAFETY_PRESETS, "not-blank"]);
  });

  it("refuses a name it does not know, from plain JS", () => {
    expect(() => expandInvariantNames(["axe" as never])).toThrow('unknown invariant "axe"');
  });
});

describe("the main crawl's --invariants / --data-safety", () => {
  it("builds the presets as crawler invariants", () => {
    expect(names(["--data-safety"])).toEqual(DATA_SAFETY_NAMES);
    expect(names(["--invariants", "data-safety"])).toEqual(DATA_SAFETY_NAMES);
    expect(names(["--invariants", "not-blank", "--invariants", "xss-marker"])).toEqual(["data.xss-marker", "data.not-blank"]);
    expect(names(["--data-safety", "--invariants", "rendered-garbage,not-blank"])).toEqual([...DATA_SAFETY_NAMES, "data.not-blank"]);
    expect(crawl([]).invariants).toBeUndefined();
  });

  it("builds axe() for --invariants axe, as for --axe, and checks its peer the same way", () => {
    expect(names(["--invariants", "axe"])).toEqual(names(["--axe"]));
    expect(names(["--axe", "--invariants", "axe,not-blank"])).toEqual(["a11y-axe", "data.not-blank"]);
    // --axe-tags applies to it too.
    expect(crawl(["--invariants", "axe", "--axe-tags", "wcag2a"]).cliReproFlags).toEqual(crawl(["--axe", "--axe-tags", "wcag2a"]).cliReproFlags);
    const needs = (argv: string[]) => crawlCliPeerNeeds(parseCrawlArgs(["--url", URL, ...argv]).values);
    expect(needs(["--invariants", "axe"])).toEqual([{ by: "--invariants axe", peers: AXE_PEERS }]);
    expect(needs(["--axe", "--invariants", "axe"])).toEqual([{ by: "--axe", peers: AXE_PEERS }]);
    expect(needs(["--data-safety"])).toEqual([]);
  });

  it("refuses an unknown name before the browser starts", () => {
    expect(() => crawl(["--invariants", "xss"])).toThrow(UsageError);
  });
});

describe("scan's --invariants / --data-safety", () => {
  it("sets ScanOptions.invariants, and axe for the alias", () => {
    expect(scan(["--data-safety"]).invariants).toEqual(DATA_SAFETY_PRESETS);
    expect(scan(["--invariants", "not-blank,data-safety"]).invariants).toEqual([...DATA_SAFETY_PRESETS, "not-blank"]);
    expect(scan(["--invariants", "axe"])).toMatchObject({ axe: true });
    expect(scan(["--invariants", "axe"]).invariants).toBeUndefined();
    expect(scan([]).invariants).toBeUndefined();
  });

  it("refuses an unknown name as a usage error", () => {
    expect(() => scan(["--invariants", "nope"])).toThrow(UsageError);
    expect(() => scan(["--invariants", ""])).toThrow("--invariants needs at least one name");
  });
});
