import { defineConfig } from "vitest/config";

// Unit tests live next to their module as src/**/*.test.ts. The analyze layer
// is pure; collector.ts pulls in Playwright/web-vitals at module load, so it
// has no unit test file.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // examples/*.spec.ts are Playwright tests; keep the vitest runner out of them.
    // .direnv holds a Nix-materialized copy of the repo (incl. examples) — exclude it too.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**", "examples/**"],
  },
});
