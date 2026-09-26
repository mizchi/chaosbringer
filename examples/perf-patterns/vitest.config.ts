import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts", "src/**/*.test.ts"],
    // Patterns are measured one after another: parallel browsers would
    // contend for the CPU and blur exactly the numbers being compared.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
