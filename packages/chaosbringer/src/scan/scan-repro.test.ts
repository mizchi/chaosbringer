import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { faults } from "../faults.js";
import { SCAN_FAULT_KINDS, type ScanFaultKind } from "./analyze.js";
import { parseScanArgs, SCAN_CLI_OPTIONS, scanOptionsFromCli } from "./cli.js";
import { scanReproCommand, type ScanOptions } from "./run.js";

const URL = "http://127.0.0.1:4455/";

/** argv → options the way `chaosbringer scan` does it. */
function scanOptions(argv: string[]): ScanOptions {
  return scanOptionsFromCli(parseScanArgs(argv).values);
}

/** A command split into words by `sh` itself, so the quoting is checked by a real shell. */
function shellWords(command: string): string[] {
  return execFileSync("sh", ["-c", `printf '%s\\0' ${command}`], { encoding: "utf8" }).split("\0").slice(0, -1);
}

/**
 * What decides a chaos crawl's findings: everything but where the files go,
 * what is shown, the seed and the fault list (the repro sets those itself),
 * and the hang time of a crawl that holds no request.
 */
function shape(o: ScanOptions, kind: ScanFaultKind) {
  const { outDir: _out, faults: _faults, seed: _seed, hangReleaseMs, crawler, ...rest } = o;
  const { headless: _headless, bind: _bind, ...c } = crawler ?? {};
  return { ...rest, crawler: c, ...(kind === "hang" ? { hangReleaseMs } : {}) };
}

/** A sample for every scan flag that shapes a chaos crawl's report. Each must come back from its repro. */
const ROUND_TRIPS: Record<string, string[]> = {
  url: ["--url", "http://127.0.0.1:4455/search?q=a&page=2"],
  "max-pages": ["--max-pages", "3"],
  "max-actions": ["--max-actions", "2"],
  seed: ["--seed", "7"],
  axe: ["--axe"],
  "aria-targets": ["--aria-targets"],
  "no-coverage": ["--no-coverage"],
  "hang-ms": ["--hang-ms", "1500"],
  exclude: ["--exclude", "/logout", "--exclude=-x"],
  "ignore-error": ["--ignore-error", "third-party", "--ignore-error", "it's \\.js$"],
  "ignore-analytics": ["--ignore-analytics", "--ignore-preset", "analytics"],
  "ignore-preset": ["--ignore-preset", "maps,pdf-orb"],
  "storage-state": ["--storage-state", "ss.json"],
  sitemap: ["--sitemap", "sitemap.xml"],
  network: ["--network", "slow-3g"],
  device: ["--device", "Pixel 7"],
  timeout: ["--timeout", "5000"],
};

/** Flags the repro leaves out on purpose, with why. */
const LEFT_OUT: Record<string, string> = {
  out: "where the files go",
  faults: "replaced by the one fault of the report's crawl",
  "no-chaos": "a chaos crawl's report comes from a scan with the chaos crawls on",
  bind: "lets other clients watch the browser",
  "bind-title": "lets other clients watch the browser",
  headless: "the reader decides whether to watch the window",
  "no-headless": "the reader decides whether to watch the window",
  "fail-on": "the exit code, from the findings; not what the report holds",
  quiet: "output",
  help: "not a run",
};

describe("a scan chaos report's reproCommand", () => {
  it("names every flag of the scan CLI exactly once, and nothing else", () => {
    const listed = [...Object.keys(ROUND_TRIPS), ...Object.keys(LEFT_OUT)].sort();
    expect(listed).toEqual(Object.keys(SCAN_CLI_OPTIONS).sort());
  });

  it.each(Object.entries(ROUND_TRIPS))("--%s comes back from each fault's command", (flag, argv) => {
    expect(argv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`))).toBe(true);
    const before = scanOptions(["--url", URL, ...argv]);
    // A sample that changed nothing would pass without testing anything.
    expect(before).not.toEqual(scanOptions(["--url", URL]));
    for (const kind of SCAN_FAULT_KINDS) {
      const command = scanReproCommand(before, 42, kind);
      const words = shellWords(command);
      expect(words.slice(0, 2)).toEqual(["chaosbringer", "scan"]);
      // parseArgs is strict: an unknown or malformed flag throws here.
      const after = scanOptions(words.slice(2));
      expect(after.seed).toBe(42);
      expect(after.faults).toEqual([kind]);
      expect(shape(after, kind)).toEqual(shape(before, kind));
      expect(scanReproCommand(after, 42, kind)).toBe(command);
    }
  });

  it("is the scan with that one fault, not the plain crawl that reran clean", () => {
    const o = scanOptions(["--url", URL, "--seed", "7", "--sitemap", "sitemap.xml", "--hang-ms", "1500"]);
    expect(scanReproCommand(o, 7, "status")).toBe(`chaosbringer scan --url ${URL} --seed 7 --faults 500 --sitemap sitemap.xml`);
    expect(scanReproCommand(o, 7, "hang")).toBe(`chaosbringer scan --url ${URL} --seed 7 --faults hang --hang-ms 1500 --sitemap sitemap.xml`);
  });

  it("ends in a comment naming what the options set in code", () => {
    const o: ScanOptions = {
      url: URL,
      crawler: { invariants: [{ name: "cart-total", check: () => true }], runtimeFaults: [faults.clockSkew(60_000)] },
    };
    const command = scanReproCommand(o, 7, "abort");
    expect(command).toBe(
      `chaosbringer scan --url ${URL} --seed 7 --faults abort # + 1 runtime fault, 1 invariant not expressible on the CLI: clock-skew:60000ms, cart-total`,
    );
    expect(shellWords(command)).toEqual(["chaosbringer", "scan", "--url", URL, "--seed", "7", "--faults", "abort"]);
  });
});
