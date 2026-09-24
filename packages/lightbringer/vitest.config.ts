import { defineConfig } from "vitest/config";

// Unit tests live next to their module as src/**/*.test.ts. The analyze layer
// is pure; session.ts / capture.ts drive a live Page + CDPSession (session.ts
// also loads web-vitals via config.ts), so they have no unit test file — the
// Playwright e2e suite covers them.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // examples/*.spec.ts are Playwright tests; keep the vitest runner out of them.
    // .direnv holds a Nix-materialized copy of the repo (incl. examples) — exclude it too.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**", "examples/**"],
  },
});
