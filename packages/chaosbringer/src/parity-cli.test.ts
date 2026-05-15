import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runParityCli } from "./parity-cli.js";

/**
 * The CLI calls the global `fetch`. We stub it per-test so unit tests
 * don't go over the wire. parity.ts itself is tested with a direct
 * fetcher injection; here we exercise the CLI surface (path-file parse,
 * exit code, JSON output, missing-args handling).
 */

describe("runParityCli", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-parity-cli-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    globalThis.fetch = originalFetch;
    process.exitCode = 0;
  });

  function logged(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  function writePaths(name: string, paths: string[]): string {
    const p = join(dir, name);
    writeFileSync(p, paths.join("\n"));
    return p;
  }

  function stubFetch(handlers: Record<string, () => Response | Promise<Response>>) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const handler = handlers[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    }) as typeof fetch;
  }

  it("exits 0 when both sides agree on every path", async () => {
    stubFetch({
      "http://l/foo": () => new Response("", { status: 200 }),
      "http://r/foo": () => new Response("", { status: 200 }),
    });
    const pathsFile = writePaths("paths.txt", ["/foo"]);
    await runParityCli(["--left", "http://l", "--right", "http://r", "--paths", pathsFile]);
    // `process.exitCode` stays at its default (undefined) when the CLI
    // never sets it. Either undefined or 0 is success.
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    expect(logged()).toContain("0 mismatch");
  });

  it("exits 1 and prints the mismatch when sides disagree", async () => {
    stubFetch({
      "http://l/foo": () => new Response("", { status: 200 }),
      "http://r/foo": () => new Response("", { status: 500 }),
    });
    const pathsFile = writePaths("paths.txt", ["/foo"]);
    await runParityCli(["--left", "http://l", "--right", "http://r", "--paths", pathsFile]);
    expect(process.exitCode).toBe(1);
    expect(logged()).toContain("STATUS");
    expect(logged()).toContain("/foo");
  });

  it("writes the JSON report to --output, creating parent directories", async () => {
    stubFetch({
      "http://l/foo": () => new Response("", { status: 200 }),
      "http://r/foo": () => new Response("", { status: 200 }),
    });
    const pathsFile = writePaths("paths.txt", ["/foo"]);
    const outPath = join(dir, "nested", "deep", "parity.json");
    await runParityCli([
      "--left",
      "http://l",
      "--right",
      "http://r",
      "--paths",
      pathsFile,
      "--output",
      outPath,
    ]);
    expect(existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(parsed.pathsChecked).toBe(1);
    expect(parsed.matches).toHaveLength(1);
  });

  it("skips blank lines and #-prefixed comments in the paths file", async () => {
    stubFetch({
      "http://l/foo": () => new Response("", { status: 200 }),
      "http://r/foo": () => new Response("", { status: 200 }),
    });
    const pathsFile = writePaths("paths.txt", ["# comment", "", "/foo", "  ", "# another"]);
    await runParityCli(["--left", "http://l", "--right", "http://r", "--paths", pathsFile]);
    expect(logged()).toContain("Checked 1 path(s)");
  });

  it("strips inline `#` comments so they don't leak into the request URL", async () => {
    // Without this guard the path "/foo  # comment" would be passed to
    // `new URL(...)` and `#` would be parsed as a fragment marker —
    // the server would receive "/foo  " with trailing whitespace and
    // never see the comment, masking the parse failure with an
    // accidentally-correct route match.
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input.toString();
      seen.push(u);
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const pathsFile = writePaths("paths.txt", ["/foo  # this is an annotation"]);
    await runParityCli(["--left", "http://l", "--right", "http://r", "--paths", pathsFile]);
    expect(seen).toEqual(["http://l/foo", "http://r/foo"]);
  });

  it("exits 1 with a helpful error when required flags are missing", async () => {
    await runParityCli(["--left", "http://l"]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("exits 1 when the paths file has no usable entries", async () => {
    const pathsFile = writePaths("paths.txt", ["# only comments"]);
    await runParityCli(["--left", "http://l", "--right", "http://r", "--paths", pathsFile]);
    expect(process.exitCode).toBe(1);
  });

  it("--help prints usage", async () => {
    await runParityCli(["--help"]);
    expect(logged()).toContain("Usage: chaosbringer parity");
  });
});
