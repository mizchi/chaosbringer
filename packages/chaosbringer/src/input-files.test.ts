import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageError } from "./cli-usage.js";
import { checkInputFiles, readInputJson } from "./input-files.js";
import { TRACE_FORMAT_VERSION } from "./trace.js";

describe("checkInputFiles", () => {
  let dir: string;
  const at = (name: string, body?: string) => {
    const path = join(dir, name);
    if (body !== undefined) writeFileSync(path, body);
    return path;
  };
  const refusal = (options: Parameters<typeof checkInputFiles>[0]) => {
    try {
      checkInputFiles(options);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      return (err as Error).message;
    }
    return undefined;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-input-files-"));
    mkdirSync(join(dir, "a-dir"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("passes the files a crawl can use, and options that name none", () => {
    const state = at("state.json", JSON.stringify({ cookies: [], origins: [] }));
    const har = at("net.har", JSON.stringify({ log: { version: "1.2", entries: [] } }));
    // Playwright reads a zipped HAR too; its contents are its business.
    const zip = at("net.zip", "PK");
    const trace = at(
      "t.jsonl",
      `${JSON.stringify({ kind: "meta", v: TRACE_FORMAT_VERSION, seed: 1, baseUrl: "http://x.test/", startTime: 0 })}\n`,
    );
    expect(refusal({})).toBeUndefined();
    expect(refusal({ storageState: state, har: { path: har, mode: "replay" }, traceReplay: trace })).toBeUndefined();
    expect(refusal({ har: { path: zip, mode: "replay" } })).toBeUndefined();
    // A HAR being recorded is written, not read.
    expect(refusal({ har: { path: join(dir, "new.har"), mode: "record" } })).toBeUndefined();
  });

  it.each([
    ["--storage-state", (p: string) => ({ storageState: p })],
    ["--har-replay", (p: string) => ({ har: { path: p, mode: "replay" as const } })],
    ["--trace-replay", (p: string) => ({ traceReplay: p })],
  ])("names %s and the path of a file that is not there, or is a directory", (flag, options) => {
    const missing = join(dir, "missing");
    expect(refusal(options(missing))).toBe(`${flag} ${missing}: no such file`);
    expect(refusal(options(join(dir, "a-dir")))).toBe(`${flag} ${join(dir, "a-dir")}: is a directory, not a file`);
  });

  it("refuses a storage state that is not Playwright's storageState JSON", () => {
    const notJson = at("bad-state.json", "{ cookies: [] }");
    expect(refusal({ storageState: notJson })).toMatch(
      new RegExp(`^--storage-state ${notJson}: not a storage state file \\(not JSON: .+\\)$`),
    );
    const list = at("list-state.json", "[]");
    expect(refusal({ storageState: list })).toBe(
      `--storage-state ${list}: not a storage state file (expected an object with "cookies" and "origins" arrays)`,
    );
    const cookies = at("cookies-state.json", JSON.stringify({ cookies: {} }));
    expect(refusal({ storageState: cookies })).toBe(
      `--storage-state ${cookies}: not a storage state file (expected an object with "cookies" and "origins" arrays)`,
    );
  });

  it("refuses a HAR that is not HAR JSON", () => {
    const notJson = at("bad.har", "<html>");
    expect(refusal({ har: { path: notJson, mode: "replay" } })).toMatch(
      new RegExp(`^--har-replay ${notJson}: not a HAR file \\(not JSON: .+\\)$`),
    );
    const noEntries = at("empty.har", JSON.stringify({ log: {} }));
    expect(refusal({ har: { path: noEntries, mode: "replay" } })).toBe(
      `--har-replay ${noEntries}: not a HAR file (expected {"log": {"entries": [...]}})`,
    );
  });

  it("refuses a trace the replay could not read, with the line that is wrong", () => {
    const bad = at("bad.jsonl", `${JSON.stringify({ kind: "meta", v: TRACE_FORMAT_VERSION })}\nnot json\n`);
    expect(refusal({ traceReplay: bad })).toMatch(
      new RegExp(`^--trace-replay ${bad}: not a chaosbringer trace \\(line 2 is not valid JSON: .+\\)$`),
    );
    const noMeta = at("no-meta.jsonl", `${JSON.stringify({ kind: "visit", url: "http://x.test/" })}\n`);
    expect(refusal({ traceReplay: noMeta })).toBe(
      `--trace-replay ${noMeta}: not a chaosbringer trace (trace is missing a leading meta entry)`,
    );
  });

  it("refuses a sitemap path that is not there, and leaves a sitemap URL to the crawl", () => {
    const missing = join(dir, "missing.xml");
    expect(refusal({ seedFromSitemap: missing })).toBe(`--seed-from-sitemap ${missing}: no such file`);
    expect(refusal({ seedFromSitemap: join(dir, "a-dir") })).toBe(
      `--seed-from-sitemap ${join(dir, "a-dir")}: is a directory, not a file`,
    );
    expect(refusal({ seedFromSitemap: at("sitemap.xml", "<urlset/>") })).toBeUndefined();
    // Fetched by the crawler, best-effort: a server down for a moment does not refuse the run.
    expect(refusal({ seedFromSitemap: "http://127.0.0.1:9/sitemap.xml" })).toBeUndefined();
    expect(refusal({ seedFromSitemap: "HTTPS://127.0.0.1:9/sitemap.xml" })).toBeUndefined();
    expect(() => checkInputFiles({ seedFromSitemap: missing }, { seedFromSitemap: "--sitemap" })).toThrow(
      `--sitemap ${missing}: no such file`,
    );
  });

  it("reads a JSON input file, naming the flag for one that is missing or not JSON", () => {
    expect(readInputJson("--perf-budgets", at("b.json", '{"version":1}'), "perf budgets")).toEqual({ version: 1 });
    expect(() => readInputJson("--perf-budgets", join(dir, "missing"), "perf budgets")).toThrow(
      `--perf-budgets ${join(dir, "missing")}: no such file`,
    );
    expect(() => readInputJson("--perf-budgets", at("b.txt", "nope"), "perf budgets")).toThrow(
      new RegExp(`^--perf-budgets ${join(dir, "b.txt")}: not a perf budgets file \\(not JSON: .+\\)$`),
    );
  });

  it("names the flag it is given, for a command that calls the file something else", () => {
    expect(refusal({ traceReplay: join(dir, "missing") })).toContain("--trace-replay");
    expect(() => checkInputFiles({ traceReplay: join(dir, "missing") }, { traceReplay: "--trace" })).toThrow(
      `--trace ${join(dir, "missing")}: no such file`,
    );
  });
});
