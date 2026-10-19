/**
 * The hand-built reports the docs tell a caller to pass to the fault readers,
 * put through the compiler. After `testPage()`, which returns no report, the
 * README and the skill's api.md say to call
 * `unfiredFaults({ faultInjections: crawler.getFaultStats(), pages: [result] })`,
 * and a `faults` session's stats go in the same way. The readers took a whole
 * `CrawlReport`, so for anyone running tsc those calls did not compile
 * (TS2740: missing baseUrl, seed, reproCommand, …). vitest strips types
 * without checking them, so only tsc can tell.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));
const require = createRequire(import.meta.url);
const TSC = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const TYPE_ROOTS = join(dirname(require.resolve("@types/node/package.json")), "..");

const DOCUMENTED = `
import {
  type ChaosCrawler,
  type FaultSession,
  type PageResult,
  faultFirings,
  faultWarnings,
  unfiredFaults,
} from "chaosbringer";

declare const crawler: ChaosCrawler;
declare const result: PageResult;
declare const session: FaultSession;

// README "Fault warnings", after testPage().
export const afterTestPage: string[] = unfiredFaults({
  faultInjections: crawler.getFaultStats(),
  runtimeFaults: crawler.getRuntimeFaultStats(),
  pages: [result],
});
// references/api.md, testPage().
export const networkOnly: string[] = unfiredFaults({ faultInjections: crawler.getFaultStats(), pages: [result] });
// references/api.md, a faults session.
export async function fromSession(): Promise<string[]> {
  return unfiredFaults({ faultInjections: session.stats(), runtimeFaults: await session.runtimeStats() });
}
export const warnings = faultWarnings({ faultInjections: crawler.getFaultStats(), pages: [result] });
export const firings = faultFirings({ runtimeFaults: crawler.getRuntimeFaultStats() });
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Type-checks `source` against the package's own source; returns tsc's output, "" when clean. */
function typecheck(source: string): Promise<{ code: number | null; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), "firings-types-"));
  dirs.push(dir);
  writeFileSync(join(dir, "snippet.ts"), source);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        typeRoots: [TYPE_ROOTS],
        types: ["node"],
        paths: { chaosbringer: [INDEX] },
      },
      files: ["snippet.ts"],
    }),
  );
  return new Promise((resolve) => {
    execFile(process.execPath, [TSC, "-p", join(dir, "tsconfig.json")], { timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, output: `${stdout}${stderr}`.trim() });
    });
  });
}

describe("the fault readers' documented hand-built reports", () => {
  it("compile", async () => {
    expect(await typecheck(DOCUMENTED)).toEqual({ code: 0, output: "" });
  }, 60_000);

  it("still reject a field that is not a fault layer's stats", async () => {
    // Proves the check above runs at all: a snippet tsc is given must be able to fail.
    const wrong = `import { unfiredFaults } from "chaosbringer";\nunfiredFaults({ faultInjections: [{ rule: 1 }] });\n`;
    const r = await typecheck(wrong);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("snippet.ts");
  }, 60_000);
});
