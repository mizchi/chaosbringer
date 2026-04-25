import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReproScript,
  failureBundleKey,
  shouldSaveArtifacts,
  writeFailureBundle,
  type FailureBundleInfo,
} from "./failure-artifacts.js";
import type { PageError, PageResult, TraceEntry } from "./types.js";

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
    expect(reproSh).toContain("--trace-replay ./trace.jsonl");

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
