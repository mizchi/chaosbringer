/**
 * Playwright Test config for `fixture.pw.ts`, the suite that runs
 * `chaosbringer/fixture` under the real test runner. `src/fixture.e2e.test.ts`
 * starts the site and drives this; it is not meant to be run on its own.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.pw.ts",
  outputDir: process.env.CHAOS_FIXTURE_OUTPUT_DIR,
  reporter: [["json", { outputFile: process.env.CHAOS_FIXTURE_REPORT }]],
  timeout: 60_000,
  projects: [
    { name: "baseURL", use: { baseURL: process.env.CHAOS_FIXTURE_BASE_URL }, grepInvert: /@no-base-url/ },
    // A config that sets no `baseURL` at all: `test.use({ baseURL: undefined })`
    // falls back to the config's value rather than unsetting it.
    { name: "no baseURL", grep: /@no-base-url/ },
  ],
});
