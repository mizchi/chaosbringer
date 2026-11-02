import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataPattern } from "./pattern.js";
import { checkPattern, loadPatterns, shardPatterns } from "./registry.js";

/** A minimal entry, as a pattern file would export it. */
const entry = (over: Partial<DataPattern> = {}) => ({
  id: "a",
  title: "t",
  category: "bug-data",
  description: "d",
  fix: "f",
  realism: "r",
  routes: () => ({}),
  inject: { channel: "query", bad: "?q=1", benign: "?q=2" },
  expect: { signal: { kind: "invariant", name: "data.xss-marker" } },
  ...over,
});

/** The source of a pattern file exporting `entry(over)`; `routes` is a function, so not JSON. */
const source = (over: Record<string, unknown>) =>
  `export default { ...${JSON.stringify({ ...entry(), routes: undefined, ...over })}, routes: () => ({}) };\n`;

describe("loadPatterns", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "data-patterns-registry-"));
    writeFileSync(join(dir, "a.ts"), source({ id: "a" }));
    writeFileSync(join(dir, "b.ts"), source({ id: "b" }));
    writeFileSync(join(dir, "_draft.ts"), source({ id: "not-the-file-name" }));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads every file, sorted, and skips the ones starting with _", async () => {
    expect((await loadPatterns("", dir)).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("narrows to the PATTERN list", async () => {
    expect((await loadPatterns("b", dir)).map((p) => p.id)).toEqual(["b"]);
    expect((await loadPatterns(" b , a ", dir)).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("refuses a PATTERN that names no file", async () => {
    await expect(loadPatterns("a,nope", dir)).rejects.toThrow(/unknown pattern\(s\): nope/);
  });

  it("refuses a pattern whose id is not its file name", async () => {
    const bad = mkdtempSync(join(tmpdir(), "data-patterns-registry-"));
    try {
      writeFileSync(join(bad, "wrong-id.ts"), source({ id: "other" }));
      await expect(loadPatterns("", bad)).rejects.toThrow(/id "other" must equal the file name "wrong-id"/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it("loads the catalog itself", async () => {
    const all = await loadPatterns("");
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((p) => p.id)).toContain("null-relation");
  });
});

describe("checkPattern", () => {
  it("accepts a data entry and an oracle entry", () => {
    expect(checkPattern(entry(), "a.ts").id).toBe("a");
    const oracle = entry({ category: "oracle", inject: { channel: "none" }, expect: { signal: "none" } });
    expect(checkPattern(oracle, "a.ts").category).toBe("oracle");
  });

  it("refuses something that is not a pattern", () => {
    expect(() => checkPattern(undefined, "a.ts")).toThrow(/must default-export a DataPattern/);
    expect(() => checkPattern({ id: "a" }, "a.ts")).toThrow(/must default-export a DataPattern/);
  });

  it("holds an oracle entry to channel none and signal none", () => {
    expect(() => checkPattern(entry({ category: "oracle", expect: { signal: "none" } }), "a.ts")).toThrow(/oracle entry takes/);
    expect(() => checkPattern(entry({ category: "oracle", inject: { channel: "none" } }), "a.ts")).toThrow(/oracle entry takes/);
  });

  it("keeps channel none and signal none to oracle entries", () => {
    expect(() => checkPattern(entry({ inject: { channel: "none" } }), "a.ts")).toThrow(/only an oracle entry/);
    expect(() => checkPattern(entry({ expect: { signal: "none" } }), "a.ts")).toThrow(/only an oracle entry/);
  });
});

describe("shardPatterns", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];

  it("returns everything without a spec", () => {
    expect(shardPatterns(ids, undefined)).toEqual(ids);
    expect(shardPatterns(ids, "")).toEqual(ids);
    expect(shardPatterns(ids, "  ")).toEqual(ids);
  });

  it("deals round-robin, 1-based", () => {
    expect(shardPatterns(ids, "1/3")).toEqual(["a", "d", "g"]);
    expect(shardPatterns(ids, "2/3")).toEqual(["b", "e"]);
    expect(shardPatterns(ids, " 3 / 3 ")).toEqual(["c", "f"]);
    expect(shardPatterns(ids, "1/1")).toEqual(ids);
  });

  it("covers every pattern exactly once across the shards", () => {
    for (const count of [1, 2, 3, 4, 8]) {
      const all = Array.from({ length: count }, (_, i) => shardPatterns(ids, `${i + 1}/${count}`)).flat();
      expect(all.sort()).toEqual(ids);
    }
  });

  it("rejects a malformed or out-of-range spec", () => {
    for (const bad of ["3", "0/3", "4/3", "1/0", "a/b", "-1/3"]) {
      expect(() => shardPatterns(ids, bad), bad).toThrow(/PATTERN_SHARD/);
    }
  });
});
