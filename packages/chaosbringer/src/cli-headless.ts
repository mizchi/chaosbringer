/**
 * `--headless` / `--no-headless`, the same on every CLI.
 *
 * `parseArgs` has no negated booleans before Node 22.4 (`allowNegative`),
 * and the package supports Node 20, so `--no-headless` is its own flag. The
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
