/**
 * `--headless` / `--no-headless`, the same on every CLI.
 *
 * `--no-headless` is its own flag rather than `parseArgs`' `allowNegative`:
 * that option needs Node 22.4, above the package's `engines` floor (>=22),
 * and it would accept `--no-<x>` for every boolean flag, not just this one. The
 * main CLI used to declare only `headless` and advertise `--no-headless`,
 * which then threw "Unknown option"; the recipe commands read
 * `values.headless !== false`, which nothing could make false. Both always
 * ran headless.
 */
export const HEADLESS_OPTIONS = {
  headless: { type: "boolean" as const },
  "no-headless": { type: "boolean" as const },
};

/** Headless unless `--no-headless` (or `--headless=false` programmatically) was given. */
export function resolveHeadless(values: { headless?: boolean; "no-headless"?: boolean }): boolean {
  if (values["no-headless"]) return false;
  return values.headless ?? true;
}
