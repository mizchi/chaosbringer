import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawlerOptionsFromCli, parseCrawlArgs } from "./cli-crawl-options.js";
import { DEFAULT_OPTIONS } from "./defaults.js";
import {
  buildReproScript,
  failureBundleKey,
  shouldSaveArtifacts,
  writeFailureBundle,
  type FailureBundleInfo,
} from "./failure-artifacts.js";
import { faults } from "./faults.js";
import { reproFlags, unreplayedNote } from "./repro-command.js";
import type { CrawlerOptions, PageError, PageResult, TraceEntry } from "./types.js";

function page(url: string, overrides: Partial<PageResult> = {}): PageResult {
  return {
    url,
    status: "success",
    loadTime: 100,
    errors: [],
    hasErrors: false,
    warnings: [],
    links: [],
    ...overrides,
  };
}

const consoleError: PageError = {
  type: "console",
  message: "Uncaught TypeError: undefined is not a function",
  url: "http://localhost:3000/",
  timestamp: 0,
};

describe("shouldSaveArtifacts", () => {
  it("returns true on status=error", () => {
    expect(shouldSaveArtifacts(page("http://x/", { status: "error" }))).toBe(true);
  });

  it("returns true on status=timeout", () => {
    expect(shouldSaveArtifacts(page("http://x/", { status: "timeout" }))).toBe(true);
  });

  it("returns true on status=recovered (404 → recovered)", () => {
    expect(shouldSaveArtifacts(page("http://x/", { status: "recovered" }))).toBe(true);
  });

  it("returns true when there is at least one error", () => {
    expect(
      shouldSaveArtifacts(
        page("http://x/", { errors: [consoleError], hasErrors: true })
      )
    ).toBe(true);
  });

  it("returns false on a clean success", () => {
    expect(shouldSaveArtifacts(page("http://x/"))).toBe(false);
  });

  it("returns true for HTTP 404 even when status is still 'success' and errors is empty", () => {
    // The crawler captures bundles BEFORE the recovery branch flips status
    // to 'recovered'. A plain 404 with no JS errors must still trigger.
    expect(
      shouldSaveArtifacts(page("http://x/", { statusCode: 404 }))
    ).toBe(true);
  });

  it("returns true for HTTP 500", () => {
    expect(
      shouldSaveArtifacts(page("http://x/", { statusCode: 500 }))
    ).toBe(true);
  });

  it("returns false for HTTP 200 / 3xx", () => {
    expect(shouldSaveArtifacts(page("http://x/", { statusCode: 200 }))).toBe(false);
    expect(shouldSaveArtifacts(page("http://x/", { statusCode: 301 }))).toBe(false);
  });
});

describe("failureBundleKey", () => {
  it("produces a sortable, readable, injective key", () => {
    expect(failureBundleKey("http://x/", 0)).toMatch(/^0000__index__[0-9a-f]{8}$/);
    expect(failureBundleKey("http://x/docs/intro", 7)).toMatch(
      /^0007__docs_intro__[0-9a-f]{8}$/
    );
  });

  it("disambiguates URLs that sanitize to the same prefix", () => {
    const a = failureBundleKey("http://x/a/b", 0);
    const b = failureBundleKey("http://x/a_b", 0);
    expect(a).not.toBe(b);
  });

  it("falls back to a sanitized form for unparseable URLs", () => {
    expect(failureBundleKey("not-a-url", 1)).toMatch(/^0001__not-a-url__[0-9a-f]{8}$/);
  });
});

describe("buildReproScript", () => {
  it("emits a chaosbringer trace-replay invocation", () => {
    const s = buildReproScript({
      baseUrl: "http://localhost:3000",
      tracePath: "./trace.jsonl",
    });
    expect(s).toMatch(/^#!\/bin\/sh/);
    expect(s).toContain("chaosbringer --url http://localhost:3000 --trace-replay ./trace.jsonl");
  });

  it("quotes URLs with spaces", () => {
    const s = buildReproScript({
      baseUrl: "http://x/has space",
      tracePath: "./trace.jsonl",
    });
    expect(s).toContain("'http://x/has space'");
  });

  // The flags of a crawl that logs in, emulates a phone, settles adaptively,
  // skips /logout, ignores analytics, and fails on console errors, then `extra`.
  const runFlags = (...extra: string[]) => {
    const { values } = parseCrawlArgs([
      "--url", "http://localhost:3000", "--seed", "7", "--trace-out", "run.jsonl",
      "--storage-state", "ss.json", "--device", "Pixel 7", "--settle", "adaptive",
      "--exclude", "/logout", "--aria-targets", "--no-http-cache", "--ignore-analytics",
      "--timeout", "5000", "--strict", ...extra,
    ]);
    const options = crawlerOptionsFromCli(values, "http://localhost:3000");
    const set = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    return reproFlags({ ...DEFAULT_OPTIONS, ...set } as Required<CrawlerOptions>, 7);
  };

  it("replays with the run's flags, less --seed and --trace-out", () => {
    const s = buildReproScript({
      baseUrl: "http://localhost:3000",
      tracePath: "./trace.jsonl",
      flags: runFlags(),
      cwd: "/work/app",
    });
    const command = s.split("\n").find((l) => l.startsWith("chaosbringer "));
    expect(command).toBe(
      "chaosbringer --url http://localhost:3000 --trace-replay ./trace.jsonl --timeout 5000 " +
        "--exclude /logout --ignore-analytics --storage-state /work/app/ss.json --device 'Pixel 7' " +
        "--aria-targets --no-http-cache --settle adaptive --strict",
    );
  });

  // repro.sh runs from its bundle, so a relative path to a file the run read
  // would name a file in there. A sitemap URL is no file.
  it.each([
    ["--har-replay", "net.har", "/work/app/net.har"],
    ["--perf-budgets", "b.json", "/work/app/b.json"],
    ["--visual-baseline", "vb", "/work/app/vb"],
    ["--seed-from-sitemap", "sitemap.xml", "/work/app/sitemap.xml"],
    ["--seed-from-sitemap", "http://x/sitemap.xml", "http://x/sitemap.xml"],
  ])("writes %s %s as %s", (flag, value, expected) => {
    const s = buildReproScript({
      baseUrl: "http://localhost:3000",
      tracePath: "./trace.jsonl",
      flags: runFlags(flag, value),
      cwd: "/work/app",
    });
    const command = s.split("\n").find((l) => l.startsWith("chaosbringer ")) ?? "";
    const argv = execFileSync("sh", ["-c", `printf '%s\\0' ${command}`], { encoding: "utf8" }).split("\0");
    expect(argv.filter((_, i) => argv[i - 1] === flag)).toEqual([expected]);
  });

  // A run with a fault set in code replayed clean, and the script said nothing.
  it("says in a comment what the run set that no flag carries", () => {
    const note = unreplayedNote({ faultInjection: [faults.status(500, { urlPattern: "/api/", name: "api-500" })] });
    const s = buildReproScript({ baseUrl: "http://localhost:3000", tracePath: "./trace.jsonl", note });
    expect(s.split("\n")).toContain("# + 1 fault rule not expressible on the CLI: api-500");
    execFileSync("sh", ["-n"], { input: s });
    expect(buildReproScript({ baseUrl: "http://localhost:3000", tracePath: "./trace.jsonl" })).not.toContain("# +");
  });

  it("runs from its own directory, wherever it is started", () => {
    const work = mkdtempSync(join(tmpdir(), "chaos-repro-"));
    const bundle = join(work, "failures", "0000__index__00000000");
    const bin = join(work, "bin");
    mkdirSync(bundle, { recursive: true });
    mkdirSync(bin);
    // Stands in for the CLI: records the directory and the argv it got.
    writeFileSync(join(bin, "chaosbringer"), '#!/bin/sh\npwd > "$OUT"\nprintf \'%s\\0\' "$@" >> "$OUT"\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(bundle, "repro.sh"),
      buildReproScript({ baseUrl: "http://localhost:3000", tracePath: "./trace.jsonl", flags: runFlags(), cwd: work }),
      { mode: 0o755 },
    );
    const out = join(work, "out");
    execFileSync("sh", [join(bundle, "repro.sh")], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUT: out },
    });
    const [cwd, ...rest] = readFileSync(out, "utf8").split("\n");
    expect(realpathSync(cwd)).toBe(realpathSync(bundle));
    const argv = rest.join("\n").split("\0").slice(0, -1);
    // The CLI's own parser takes every flag; the paths still name the run's files.
    const { values } = parseCrawlArgs(argv);
    expect(values["trace-replay"]).toBe("./trace.jsonl");
    expect(values["storage-state"]).toBe(join(work, "ss.json"));
    expect(values.device).toBe("Pixel 7");
    expect(values.strict).toBe(true);
    expect(values.seed).toBeUndefined();
    expect(values["trace-out"]).toBeUndefined();
    rmSync(work, { recursive: true, force: true });
  });
});

describe("writeFailureBundle", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-fa-"));
  });

  it("creates a bundle directory with the expected files", () => {
    const result = page("http://localhost:3000/broken", {
      status: "error",
      statusCode: 500,
      errors: [consoleError],
      hasErrors: true,
    });
    const trace: TraceEntry[] = [
      { kind: "meta", v: 1, seed: 42, baseUrl: "http://localhost:3000", startTime: 0 },
      { kind: "visit", url: "http://localhost:3000/broken" },
    ];

    const bundleDir = writeFailureBundle({
      options: { dir },
      baseUrl: "http://localhost:3000",
      seed: 42,
      sequence: 0,
      result,
      screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      html: "<html><body>broken</body></html>",
      trace,
      reproFlags: [{ flag: "--url", value: "http://localhost:3000" }, { flag: "--seed", value: "42" }, { flag: "--strict" }],
      now: () => new Date("2024-01-01T00:00:00.000Z"),
    });

    expect(existsSync(bundleDir)).toBe(true);
    expect(existsSync(join(bundleDir, "screenshot.png"))).toBe(true);
    expect(existsSync(join(bundleDir, "page.html"))).toBe(true);
    expect(existsSync(join(bundleDir, "errors.json"))).toBe(true);
    expect(existsSync(join(bundleDir, "trace.jsonl"))).toBe(true);
    expect(existsSync(join(bundleDir, "repro.sh"))).toBe(true);
    expect(existsSync(join(bundleDir, "info.json"))).toBe(true);

    const info = JSON.parse(
      readFileSync(join(bundleDir, "info.json"), "utf-8")
    ) as FailureBundleInfo;
    expect(info.url).toBe("http://localhost:3000/broken");
    expect(info.status).toBe("error");
    expect(info.statusCode).toBe(500);
    expect(info.seed).toBe(42);
    expect(info.errorCount).toBe(1);
    expect(info.artifacts).toEqual({ screenshot: true, html: true, trace: true });
    expect(info.createdAt).toBe("2024-01-01T00:00:00.000Z");

    const errors = JSON.parse(readFileSync(join(bundleDir, "errors.json"), "utf-8"));
    expect(Array.isArray(errors)).toBe(true);
    expect(errors[0].message).toContain("undefined is not a function");

    const reproSh = readFileSync(join(bundleDir, "repro.sh"), "utf-8");
    expect(reproSh).toContain(
      "chaosbringer --url http://localhost:3000 --trace-replay ./trace.jsonl --strict\n",
    );

    // repro.sh is executable.
    const mode = statSync(join(bundleDir, "repro.sh")).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  });

  it("respects per-artefact opt-outs", () => {
    const result = page("http://x/a", { errors: [consoleError], hasErrors: true });
    const bundleDir = writeFailureBundle({
      options: { dir, saveScreenshot: false, saveHtml: false, saveTrace: false },
      baseUrl: "http://x",
      seed: 1,
      sequence: 0,
      result,
      screenshot: Buffer.from([0]),
      html: "<html/>",
      trace: [
        { kind: "meta", v: 1, seed: 1, baseUrl: "http://x", startTime: 0 },
        { kind: "visit", url: "http://x/a" },
      ],
    });
    expect(existsSync(join(bundleDir, "screenshot.png"))).toBe(false);
    expect(existsSync(join(bundleDir, "page.html"))).toBe(false);
    expect(existsSync(join(bundleDir, "trace.jsonl"))).toBe(false);
    expect(existsSync(join(bundleDir, "repro.sh"))).toBe(false);
    // Always present:
    expect(existsSync(join(bundleDir, "errors.json"))).toBe(true);
    expect(existsSync(join(bundleDir, "info.json"))).toBe(true);
  });

  it("skips trace artefacts when no entries are provided", () => {
    const result = page("http://x/a", { errors: [consoleError], hasErrors: true });
    const bundleDir = writeFailureBundle({
      options: { dir },
      baseUrl: "http://x",
      seed: 1,
      sequence: 2,
      result,
    });
    expect(existsSync(join(bundleDir, "trace.jsonl"))).toBe(false);
    expect(existsSync(join(bundleDir, "repro.sh"))).toBe(false);
    const info = JSON.parse(readFileSync(join(bundleDir, "info.json"), "utf-8"));
    expect(info.artifacts.trace).toBe(false);
  });
});
