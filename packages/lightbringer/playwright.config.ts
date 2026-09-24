import { defineConfig, devices } from "@playwright/test";

// PERF_GPU=1 uses hardware GL (mac: ANGLE Metal). Default headless Chromium runs
// SwiftShader (software GL), which makes WebGL / ReadPixels / GPU numbers diverge
// wildly from real hardware. Turn it on when measuring GPU-heavy pages.
const perfGpu = process.env.PERF_GPU === "1";
const gpuArgs = ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"];

// PERF_PORT overrides the fixture dev-server port. The default 5173 collides with
// any other vite project running locally; set PERF_PORT to a free port to avoid
// measuring a foreign app that a reused dev server happens to be serving.
const port = Number(process.env.PERF_PORT ?? "5173");
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./examples",
  // the bundle fixture is a production build measured by playwright.bundle.config.ts;
  // the sample project is a self-contained demo with its own config (see its README).
  testIgnore: ["**/bundle/**", "**/sample-project/**"],
  // perf measurement must be serial; parallel workers contend for CPU/GPU.
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    // bench specs use relative URLs against the fixture app; external-URL specs
    // (example.com, react.dev) pass absolute URLs and ignore this.
    baseURL: origin,
    ...(perfGpu ? { launchOptions: { args: gpuArgs } } : {}),
  },
  // serves fixtures/app for the bench specs (rerender / reflow / input)
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: !process.env.CI,
  },
});
