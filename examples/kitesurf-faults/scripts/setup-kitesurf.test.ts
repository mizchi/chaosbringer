import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_ENV, linkKitesurf, validateKitesurf } from "./setup-kitesurf.mjs";

const ASSETS = ["packages/core/pkg/core.wasm", "packages/engine/src/embed.ts"];

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

/** A throwaway checkout with one commit; `assets` are created untracked, like build outputs. */
function fakeKitesurf(assets = ASSETS) {
  const dir = mkdtempSync(join(tmpdir(), "ks-setup-"));
  tmp.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "kitesurf\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  for (const a of assets) {
    mkdirSync(join(dir, a, ".."), { recursive: true });
    writeFileSync(join(dir, a), "x");
  }
  return { dir, rev: git(dir, "rev-parse", "HEAD") };
}

const manifest = (revision: string) => ({ repo: "https://example.invalid/kitesurf", revision, requiredAssets: ASSETS, buildCommand: "pnpm run build" });

describe("validateKitesurf", () => {
  it("fails with exit code 2 when KITESURF_DIR is unset: an explicit integration run is never skipped", () => {
    const r = validateKitesurf({ env: {}, manifest: manifest("abc") });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(EXIT_ENV);
    expect(EXIT_ENV).toBe(2);
    expect(r.errors.join("\n")).toContain("KITESURF_DIR is not set");
  });

  it("fails with exit code 2 when KITESURF_DIR is not a git checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "ks-setup-"));
    tmp.push(dir);
    const r = validateKitesurf({ env: { KITESURF_DIR: dir }, manifest: manifest("abc") });
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
    expect(r.errors.join("\n")).toContain("not a git checkout");
  });

  it("fails with exit code 2 on a revision mismatch, naming both revisions", () => {
    const { dir, rev } = fakeKitesurf();
    const r = validateKitesurf({ env: { KITESURF_DIR: dir }, manifest: manifest("0".repeat(40)) });
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
    expect(r.errors.join("\n")).toContain(rev);
    expect(r.errors.join("\n")).toContain("0".repeat(40));
  });

  it("accepts an explicit KITESURF_REV override and says so in the result", () => {
    const { dir, rev } = fakeKitesurf();
    const r = validateKitesurf({ env: { KITESURF_DIR: dir, KITESURF_REV: rev }, manifest: manifest("0".repeat(40)) });
    expect(r).toMatchObject({ ok: true, revision: rev, pinnedRevision: "0".repeat(40), revisionOverridden: true });
  });

  it("fails with exit code 2 when tracked files are modified", () => {
    const { dir, rev } = fakeKitesurf();
    writeFileSync(join(dir, "README.md"), "changed\n");
    const r = validateKitesurf({ env: { KITESURF_DIR: dir }, manifest: manifest(rev) });
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
    expect(r.errors.join("\n")).toContain("uncommitted changes");
  });

  it("fails with exit code 2 listing every missing asset and the build command", () => {
    const { dir, rev } = fakeKitesurf([]);
    const r = validateKitesurf({ env: { KITESURF_DIR: dir }, manifest: manifest(rev) });
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
    const text = r.errors.join("\n");
    for (const a of ASSETS) expect(text).toContain(a);
    expect(text).toContain("pnpm run build");
  });

  it("passes for a clean checkout at the pinned revision with every asset", () => {
    const { dir, rev } = fakeKitesurf();
    const r = validateKitesurf({ env: { KITESURF_DIR: dir }, manifest: manifest(rev) });
    expect(r).toMatchObject({ ok: true, revision: rev, revisionOverridden: false, errors: [] });
  });
});

describe("linkKitesurf", () => {
  it("links @kitesurf/engine and the engine's public assets into the example", () => {
    const { dir } = fakeKitesurf();
    const example = mkdtempSync(join(tmpdir(), "ks-example-"));
    tmp.push(example);
    linkKitesurf(example, dir);
    // Run twice: the links are replaced, not stacked inside each other.
    linkKitesurf(example, dir);
    expect(readlinkSync(join(example, "node_modules/@kitesurf/engine"))).toBe(join(dir, "packages/engine"));
    expect(readlinkSync(join(example, ".kitesurf/public"))).toBe(join(dir, "packages/engine/public"));
  });
});
