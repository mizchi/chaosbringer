import { defineConfig, devices } from "@playwright/test";

// Measures a PRODUCTION build (vite build → vite preview) of fixtures/bundle, so
// the build/serving-dependent axes produce real numbers: JS/CSS coverage over real
// chunks (PERF_COV=1), render-blocking <link> CSS, and real-byte image over-fetch.
// Run with: PERF_COV=1 pnpm exec playwright test -c playwright.bundle.config.ts
const port = Number(process.env.PERF_PORT ?? "4273");
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./examples/bundle",
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  use: { ...devices["Desktop Chrome"], baseURL: origin },
  webServer: {
    command:
      `node fixtures/bundle/gen-image.mjs && ` +
      `pnpm exec vite build -c vite.bundle.config.ts && ` +
      `pnpm exec vite preview -c vite.bundle.config.ts --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
