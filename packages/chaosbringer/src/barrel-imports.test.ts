import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `@playwright/test` is an *optional* peer dependency, and the root barrel
 * used to re-export `./fixture.js`, which imports it at module scope. So
 * `import { chaos } from "chaosbringer"` threw
 * `Cannot find package '@playwright/test'` for anyone who had installed
 * `playwright` alone — and the `exports` map offered no way around it, so the
 * only fix available to a user was to install a package they were told was
 * optional. Four separate first-time readers of this library lost their first
 * stretch of work to it.
 *
 * A `toContain` on one file would not catch a regression: the import can
 * arrive through any depth of re-export. This walks the built graph.
 */
describe("the root barrel and the optional peers", () => {
  const distDir = resolve(__dirname, "..", "dist");

  /** Every module reachable from `entry` by static import, as file paths. */
  function reachable(entry: string): { files: Set<string>; bare: Map<string, string[]> } {
    const files = new Set<string>();
    const bare = new Map<string, string[]>();
    const queue = [resolve(distDir, entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // .d.ts-only or missing — nothing to walk
      }
      // Static `import ... from "x"` / `export ... from "x"` only. A dynamic
      // `await import()` is deliberately out of scope: it fails at call time,
      // which is the behaviour we want for an optional dependency.
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith(".")) {
          queue.push(resolve(dirname(file), spec));
        } else {
          bare.set(spec, [...(bare.get(spec) ?? []), file]);
        }
      }
    }
    return { files, bare };
  }

  it("does not reach @playwright/test from the package root", () => {
    const { bare } = reachable("index.js");
    const offenders = bare.get("@playwright/test");
    expect(
      offenders,
      `@playwright/test is reachable from dist/index.js via:\n${(offenders ?? []).join("\n")}`,
    ).toBeUndefined();
  });

  it("still reaches it from the fixture subpath, which is what that subpath is for", () => {
    // The guard above must not be satisfiable by deleting the fixture.
    const { bare } = reachable("fixture.js");
    expect(bare.get("@playwright/test")).toBeDefined();
  });

  it("reaches `playwright` from the root, which is the peer that is not optional", () => {
    const { bare } = reachable("index.js");
    expect([...bare.keys()]).toContain("playwright");
  });

  it("keeps the other optional peers out of the root graph too", () => {
    // Same failure mode, three more chances at it: a report formatter that
    // imports pngjs at module scope makes an image library mandatory for
    // anyone who just wants to crawl.
    const { bare } = reachable("index.js");
    for (const optional of ["axe-core", "pixelmatch", "pngjs"]) {
      expect(bare.get(optional), `${optional} is reachable from dist/index.js`).toBeUndefined();
    }
  });

  it("walks a graph deep enough for the test to mean something", () => {
    // A regex that matched nothing would make every assertion above vacuous.
    const { files } = reachable("index.js");
    expect(files.size).toBeGreaterThan(40);
    expect([...files].some((f) => f.endsWith(join("dist", "crawler.js")))).toBe(true);
  });
});
