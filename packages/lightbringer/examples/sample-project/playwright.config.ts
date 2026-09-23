import { defineConfig, devices } from "@playwright/test";

// Self-contained config for the sample project. It starts the zero-dependency
// static server (serve.mjs) and points the spec at it, so the whole thing runs
// with a single command from the repo root:
//
//   pnpm exec playwright test --config examples/sample-project/playwright.config.ts
//
// The root playwright.config.ts ignores this directory (see its testIgnore), so
// the sample never interferes with the tool's own bench suite.
const PORT = Number(process.env.PORT ?? "4321");
const origin = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: ".",
  reporter: "line",
  // perf measurement must be serial.
  workers: 1,
  fullyParallel: false,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: origin,
  },
  webServer: {
    command: `node serve.mjs`,
    url: origin,
    reuseExistingServer: true,
  },
});
