/**
 * The files a crawl reads, checked before its browser starts.
 *
 * `--storage-state`, `--har-replay` and `--trace-replay` name files that
 * Playwright or the replay only opened once the browser was up: a missing or
 * malformed one failed the run with a stack trace and exit 1, the code of a
 * run that found something, and `scan` printed `scan failed: …` after its
 * clean crawl had started. A `--seed-from-sitemap` path that was not there
 * was dropped with a logger warning nobody saw, and the run passed without
 * its seeds. The CLI commands that take them (the crawl, `shard`, `scan`,
 * `flake`, `drive`, `minimize --trace`) call `checkInputFiles` first, and its
 * `UsageError` is one line and exit 2. `--perf-budgets` is read with
 * `readInputJson` by the crawl, before any of these.
 *
 * Apart from the flag parsers (`crawlerOptionsFromCli`, `scanOptionsFromCli`,
 * `parseFlakeArgs`), which stay free of the file system: they also read a
 * report's repro command back, whose files are on the machine that ran it.
 */
import { readFileSync, statSync } from "node:fs";
import { UsageError } from "./cli-usage.js";
import { errorMessage } from "./errors.js";
import { parseTrace } from "./trace.js";
import type { CrawlerOptions } from "./types.js";

/** The flags the files came from, for a command that names one differently (`minimize --trace`). */
export interface InputFileFlags {
  storageState?: string;
  harReplay?: string;
  traceReplay?: string;
  seedFromSitemap?: string;
}

const DEFAULT_FLAGS: Required<InputFileFlags> = {
  storageState: "--storage-state",
  harReplay: "--har-replay",
  traceReplay: "--trace-replay",
  seedFromSitemap: "--seed-from-sitemap",
};

/**
 * Throw a `UsageError` naming the flag and the path unless each file
 * `options` reads is there and parses as what it must be: a storage state as
 * Playwright's storageState JSON, a HAR as HAR JSON (a zipped HAR only has to
 * be there), a trace as a chaosbringer JSONL trace. A sitemap given as a
 * path only has to be there: one given as a URL stays best-effort, as the
 * crawler fetches it (a server that is down for a moment should not refuse
 * the run).
 */
export function checkInputFiles(
  options: Pick<CrawlerOptions, "storageState" | "har" | "traceReplay" | "seedFromSitemap">,
  flags: InputFileFlags = {},
): void {
  const flag = { ...DEFAULT_FLAGS, ...flags };
  if (typeof options.storageState === "string" && options.storageState !== "") {
    const path = options.storageState;
    const state = readInputJson(flag.storageState, path, "storage state");
    const isList = (v: unknown) => v === undefined || Array.isArray(v);
    if (!isObject(state) || !isList(state.cookies) || !isList(state.origins)) {
      throw new UsageError(
        `${flag.storageState} ${path}: not a storage state file (expected an object with "cookies" and "origins" arrays)`,
      );
    }
  }
  if (options.har?.mode === "replay") {
    const path = options.har.path;
    if (/\.zip$/i.test(path)) {
      readFile(flag.harReplay, path);
    } else {
      const har = readInputJson(flag.harReplay, path, "HAR");
      if (!isObject(har) || !isObject(har.log) || !Array.isArray(har.log.entries)) {
        throw new UsageError(`${flag.harReplay} ${path}: not a HAR file (expected {"log": {"entries": [...]}})`);
      }
    }
  }
  if (typeof options.traceReplay === "string" && options.traceReplay !== "") {
    const path = options.traceReplay;
    const text = readFile(flag.traceReplay, path);
    try {
      parseTrace(text);
    } catch (err) {
      throw new UsageError(
        `${flag.traceReplay} ${path}: not a chaosbringer trace (${errorMessage(err).replace(/^parseTrace: /, "")})`,
      );
    }
  }
  const sitemap = options.seedFromSitemap;
  if (typeof sitemap === "string" && sitemap !== "" && !/^https?:\/\//i.test(sitemap)) {
    readFile(flag.seedFromSitemap, sitemap);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readFile(flag: string, path: string): string {
  try {
    if (statSync(path).isDirectory()) throw new UsageError(`${flag} ${path}: is a directory, not a file`);
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof UsageError) throw err;
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT") throw new UsageError(`${flag} ${path}: no such file`);
    throw new UsageError(`${flag} ${path}: cannot be read (${errorMessage(err)})`);
  }
}

/**
 * A JSON input file's contents, or a `UsageError` naming the flag and the
 * path: `<flag> <path>: no such file`, `… is a directory, not a file` or
 * `… not a <what> file (not JSON: …)`.
 */
export function readInputJson(flag: string, path: string, what: string): unknown {
  const text = readFile(flag, path);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${flag} ${path}: not a ${what} file (not JSON: ${errorMessage(err)})`);
  }
}
