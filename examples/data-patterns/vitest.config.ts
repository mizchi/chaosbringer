import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts", "src/**/*.test.ts"],
    // Every case launches its own browser and server; running files side by
    // side only contends for the CPU, and the crawls are short.
    fileParallelism: false,
    testTimeout: 60_000,
    // An entry's three crawls run in its beforeAll.
    hookTimeout: 60_000,
  },
});
