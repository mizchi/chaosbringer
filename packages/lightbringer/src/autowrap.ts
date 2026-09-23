// The auto-span page fixture + autoWrap(), split out so this module imports
// @playwright/test as TYPES ONLY (no value import). The CLI's spec-mode loader
// (cli.ts → scripts/pw-resolver.mjs) imports `autoWrap` from the BUILT version of
// this file while the spec/config resolve @playwright/test to the *project's*
// install. If this module value-imported @playwright/test, that import would
// resolve to lightbringer's OWN bundled Playwright — a second instance next to the
// project's — and Playwright aborts with "Playwright Test was required from two
// locations". Keeping it type-only means exactly one Playwright is ever loaded.
//
// `src/auto.ts` is the thin `lightbringer/auto` entry that DOES value-import
// @playwright/test (safe there: a direct import resolves to the consumer's single
// install) and builds `test = autoWrap(base)`.
import fs from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import {
  startSession,
  logSummary,
  checkBudgets,
  PERF_OUT_DIR,
  CPU_RATE,
  NET_PROFILE,
  CSS_STATS,
  TRACE_ENABLED,
  COV_ENABLED,
  MEM_GC,
} from "./collector";

// Locator/Page action methods worth a span (navigations + interactions).
const ACTION_METHODS = [
  "click",
  "dblclick",
  "fill",
  "press",
  "type",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "setInputFiles",
  "tap",
  "hover",
  "dragTo",
  "clear",
] as const;

type AnyFn = (...args: unknown[]) => Promise<unknown>;

/** Playwright's page-fixture function shape (typed locally to avoid a value import). */
type PageFixture = (
  args: { page: Page },
  use: (p: Page) => Promise<void>,
  testInfo: TestInfo,
) => Promise<void>;

function locatorLabel(loc: unknown): string {
  // Locator.toString() → e.g. `locator('#run')` / `getByTestId('x')`; trim wrapper.
  const s = String(loc);
  return s.replace(/^[A-Za-z]+\(['"]?/, "").replace(/['"]?\)$/, "").slice(0, 50);
}

// The page-fixture override that auto-measures every action. Shared by the
// `lightbringer/auto` test (src/auto.ts) and autoWrap() (used by the CLI's loader
// to wrap an existing repo's @playwright/test without editing specs).
const autoPageFixture: PageFixture = async ({ page }, use, testInfo) => {
    const slug = testInfo.titlePath
      .filter(Boolean)
      .join("_")
      .replace(/[^\p{L}\p{N}_]+/gu, "_");
    const runTag = `run${testInfo.repeatEachIndex}`;
    const tracePath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.trace.json`);
    if (TRACE_ENABLED) fs.mkdirSync(PERF_OUT_DIR, { recursive: true });

    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client, {
      cpuRate: CPU_RATE,
      netProfile: NET_PROFILE,
      cssStats: CSS_STATS,
      trace: TRACE_ENABLED,
      tracePath,
      coverage: COV_ENABLED,
      memGc: MEM_GC,
    });
    if (CPU_RATE > 1 && testInfo.timeout > 0) {
      testInfo.setTimeout(testInfo.timeout * CPU_RATE);
    }
    const controller = session.controller;

    // Reentrancy guard: page.click(sel) internally drives a Locator action (also
    // wrapped); only the outermost call should open a span.
    let active = false;
    const wrap =
      (orig: AnyFn, label: (self: unknown, args: unknown[]) => string) =>
      function (this: unknown, ...args: unknown[]) {
        if (active) return orig.apply(this, args);
        active = true;
        return controller
          .measure(label(this, args), () => orig.apply(this, args))
          .finally(() => {
            active = false;
          });
      };

    // Patch page.goto + page-level action convenience methods (on the instance).
    const restore: Array<() => void> = [];
    const p = page as unknown as Record<string, AnyFn>;
    const origGoto = p.goto.bind(page);
    p.goto = wrap(origGoto, (_s, a) => `goto ${String(a[0] ?? "")}`) as AnyFn;
    restore.push(() => {
      p.goto = origGoto;
    });
    for (const m of ACTION_METHODS) {
      if (typeof p[m] !== "function") continue;
      const orig = p[m].bind(page);
      p[m] = wrap(orig, (_s, a) => `${m} ${String(a[0] ?? "")}`.slice(0, 56)) as AnyFn;
      restore.push(() => {
        p[m] = orig;
      });
    }

    // Patch the Locator prototype's action methods (covers getByRole/locator/...).
    const proto = Object.getPrototypeOf(page.locator("html")) as Record<string, AnyFn>;
    for (const m of ACTION_METHODS) {
      if (typeof proto[m] !== "function") continue;
      const orig = proto[m];
      proto[m] = wrap(orig, (self) => `${m} ${locatorLabel(self)}`) as AnyFn;
      restore.push(() => {
        proto[m] = orig;
      });
    }

    try {
      await use(page);
    } finally {
      for (const r of restore) r();
    }

    const { report, covArtifact } = await session.finish(testInfo.title);

    fs.mkdirSync(PERF_OUT_DIR, { recursive: true });
    const jsonPath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    if (covArtifact) {
      fs.writeFileSync(
        path.join(PERF_OUT_DIR, `${slug}.${runTag}.coverage.json`),
        JSON.stringify(covArtifact),
      );
    }
    await testInfo.attach("perf-report", {
      path: jsonPath,
      contentType: "application/json",
    });

    logSummary(report, MEM_GC);

    if (process.env.PERF_ASSERT === "1") {
      const violations = checkBudgets(report);
      if (violations.length > 0) {
        throw new Error(`perf budget exceeded:\n  ${violations.join("\n  ")}`);
      }
    }
};

/**
 * Wrap an existing test object with the auto-span page fixture. The CLI's loader
 * uses this to instrument a repo's own `@playwright/test` test (and any fixtures
 * merged onto it) without the spec importing lightbringer at all.
 *
 * `t` is typed structurally (every Playwright test object has `.extend`) so this
 * module needs no value import of @playwright/test — see the file header.
 */
export function autoWrap<T>(t: T): T {
  const base = t as { extend(fixtures: { page: PageFixture }): T };
  return base.extend({ page: autoPageFixture });
}
