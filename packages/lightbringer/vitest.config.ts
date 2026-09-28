import { defineConfig } from "vitest/config";

// Unit tests live next to their module as src/**/*.test.ts. The analyze layer
// is pure; session.ts drives a live Page + CDPSession (and loads web-vitals via
// config.ts), so it has no unit test file — the Playwright e2e suite covers it.
// capture.ts's NetworkRecorder and targets.ts's routing are unit-tested against
// plain events and a fake CDP target tree.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // examples/*.spec.ts are Playwright tests; keep the vitest runner out of them.
    // .direnv holds a Nix-materialized copy of the repo (incl. examples) — exclude it too.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**", "examples/**"],
  },
});
