/**
 * The main CLI as a user meets it, run as a process: `cli.ts` parses
 * `process.argv` and exits as soon as it is imported. None of these get as
 * far as starting a browser.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { crawlerOptionsFromCli, parseCrawlArgs } from "./cli-crawl-options.js";
import { SUBCOMMANDS } from "./cli-usage.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** Nothing listens here; a crawl that got this far would fail, not hang. */
const URL_ARG = ["--url", "http://127.0.0.1:9/"];

function cli(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("--help", () => {
  it("lists every subcommand of the dispatch table, one line each with its summary", () => {
    const r = cli(["-h"]);
    expect(r.status).toBe(0);
    const section = r.stdout.split("\nSUBCOMMANDS")[1]?.split("\n\n")[0] ?? "";
    const rows = section.split("\n").slice(1);
    expect(rows.map((row) => row.trim().split(/\s+/)[0])).toEqual(Object.keys(SUBCOMMANDS));
    for (const [name, sub] of Object.entries(SUBCOMMANDS)) {
      expect(rows).toContainEqual(expect.stringMatching(new RegExp(`^  ${name} +${escapeRegExp(sub.summary)}$`)));
    }
  });
});

describe("--version", () => {
  it.each([["--version"], ["-V"]])("%s prints the package.json version and exits 0", (flag) => {
    const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
    const r = cli([flag]);
    expect(r.stdout).toBe(`${version}\n`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("usage errors", () => {
  it.each([
    [["--max-page", "3"], "unknown option --max-page"],
    [["-x"], "unknown option -x"],
    [[...URL_ARG, "--max-pages", "abc"], '--max-pages must be a finite number (got "abc")'],
    [[...URL_ARG, "--max-pages", "0"], "--max-pages must be >= 1 (got 0)"],
    [[...URL_ARG, "--timeout", "5s"], '--timeout must be a finite number (got "5s")'],
    // Refused by validateOptions, which used to throw from inside main().
    [[...URL_ARG, "--cdp-target", "x"], '"cdpTargetId" requires "cdpEndpoint"'],
    [[], "--url is required"],
  ])("%j is one line on stderr and exit 2, before anything runs", (args, message) => {
    const r = cli(args);
    expect(r.stderr.trimEnd().split("\n")).toEqual([`chaosbringer: ${message} (see chaosbringer --help)`]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(2);
  });

  it("names the flag for a malformed number, where parseInt read a prefix of it", () => {
    const options = (argv: string[]) => crawlerOptionsFromCli(parseCrawlArgs(argv).values, "http://x.test/");
    expect(() => options(["--max-pages", "3x"])).toThrow("--max-pages must be a finite number");
    expect(() => options(["--max-actions-per-page", "1.5"])).toThrow("--max-actions-per-page must be an integer");
    expect(options(["--max-pages", "3", "--max-actions", "0", "--timeout", "5000"])).toMatchObject({
      maxPages: 3,
      maxActionsPerPage: 0,
      timeout: 5000,
    });
  });
});
