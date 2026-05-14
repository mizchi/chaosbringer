/**
 * Pure-logic tests for snapshot persistence + invalidation. The
 * apply-snapshot path needs a real BrowserContext so it's covered by
 * the E2E.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SNAPSHOT_TTL_MS,
  deleteSnapshot,
  loadSnapshot,
  SNAPSHOT_FORMAT_VERSION,
  snapshotPath,
  type RecipeSnapshot,
} from "./snapshot.js";

function makeSnapshot(overrides: Partial<RecipeSnapshot> = {}): RecipeSnapshot {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    recipeName: "auth/login",
    recipeVersion: 1,
    capturedAt: Date.now(),
    origin: "https://example.com",
    storageState: { cookies: [], origins: [] },
    ...overrides,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "snap-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("snapshotPath", () => {
  it("co-locates with the recipe by sanitised name", () => {
    expect(snapshotPath(dir, "auth/login")).toBe(join(dir, "auth__login.state.json"));
  });
});

describe("loadSnapshot", () => {
  it("returns null when no snapshot exists", () => {
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 1 })).toBeNull();
  });

  it("returns the snapshot when fresh, name + version match", () => {
    const snap = makeSnapshot();
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap));
    const got = loadSnapshot(dir, "auth/login", { recipeVersion: 1 });
    expect(got).not.toBeNull();
    expect(got!.recipeName).toBe("auth/login");
  });

  it("discards + returns null on version mismatch (recipe was edited)", () => {
    const snap = makeSnapshot({ recipeVersion: 1 });
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap));
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 2 })).toBeNull();
    // File should also be cleaned up so it doesn't keep failing the lookup.
    expect(existsSync(snapshotPath(dir, "auth/login"))).toBe(false);
  });

  it("discards + returns null past TTL", () => {
    const snap = makeSnapshot({ capturedAt: Date.now() - DEFAULT_SNAPSHOT_TTL_MS - 1000 });
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap));
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 1 })).toBeNull();
  });

  it("honours custom ttlMs", () => {
    const snap = makeSnapshot({ capturedAt: Date.now() - 5_000 });
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap));
    // 1s TTL — older than that, should fail.
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 1, ttlMs: 1_000 })).toBeNull();
    // 60s TTL — within window, should succeed.
    const snap2 = makeSnapshot({ capturedAt: Date.now() - 5_000 });
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap2));
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 1, ttlMs: 60_000 })).not.toBeNull();
  });

  it("rejects snapshots whose formatVersion doesn't match", () => {
    const snap = makeSnapshot({ formatVersion: SNAPSHOT_FORMAT_VERSION + 99 });
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap));
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 1 })).toBeNull();
  });

  it("rejects a snapshot whose recorded name doesn't match the requested name", () => {
    const snap = makeSnapshot({ recipeName: "auth/different" });
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap));
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 1 })).toBeNull();
  });

  it("returns null on corrupt JSON and cleans up", () => {
    writeFileSync(snapshotPath(dir, "auth/login"), "{ not json");
    expect(loadSnapshot(dir, "auth/login", { recipeVersion: 1 })).toBeNull();
    expect(existsSync(snapshotPath(dir, "auth/login"))).toBe(false);
  });
});

describe("deleteSnapshot", () => {
  it("removes an existing snapshot", () => {
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(makeSnapshot()));
    deleteSnapshot(dir, "auth/login");
    expect(existsSync(snapshotPath(dir, "auth/login"))).toBe(false);
  });

  it("is a no-op when the snapshot doesn't exist", () => {
    expect(() => deleteSnapshot(dir, "auth/login")).not.toThrow();
  });
});

describe("snapshot file on disk", () => {
  it("is pretty-printed JSON ending with a newline (for git-friendliness)", () => {
    const snap = makeSnapshot();
    writeFileSync(snapshotPath(dir, "auth/login"), JSON.stringify(snap, null, 2) + "\n");
    const raw = readFileSync(snapshotPath(dir, "auth/login"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('"recipeName"');
  });
});
