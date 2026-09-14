import { createHash } from "node:crypto";
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

/**
 * Stable digest of the set of function fingerprints a run executed.
 *
 * Two runs with the same digest ran the same code. The model pipeline uses
 * that to spot plans the model calls distinct states but that exercise
 * identical code — either the model is over-refined or the app does not
 * actually distinguish the cases, and neither is visible from the model
 * alone. Sorted before hashing so the digest is order-independent.
 */
export function coverageFingerprintOf(covered: ReadonlySet<string>): string {
  const sorted = [...covered].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 32);
}
