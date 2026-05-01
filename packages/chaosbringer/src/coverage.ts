/**
 * Re-export shim. The actual implementation moved to
 * `@mizchi/playwright-v8-coverage` (extracted Layer-1 package). This module
 * remains as a stable internal import path for the rest of chaosbringer
 * (`crawler.ts`, `index.ts`) so the extraction was a pure refactor.
 *
 * New external consumers should import from `@mizchi/playwright-v8-coverage`
 * directly. chaosbringer's public surface still re-exports these via
 * `src/index.ts` for backwards compatibility.
 */

export {
  CoverageCollector,
  coverageDelta,
  coverageSignature,
  noveltyMultiplier,
  summarizeCoverage,
  targetKey,
  type CoverageReport,
  type CoverageScriptResult,
} from "@mizchi/playwright-v8-coverage";
