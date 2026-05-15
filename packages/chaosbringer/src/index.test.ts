import { describe, expect, it } from "vitest";

/**
 * Smoke test for the public package entry. If `index.ts` accidentally
 * stops re-exporting a name (or a name gets renamed in its source
 * module), this test catches it at import time rather than waiting for
 * a downstream consumer to surface the regression.
 *
 * Only checks the symbols this branch added; older exports are covered
 * by their respective unit tests.
 */
import * as api from "./index.js";

describe("public package exports (this branch's additions)", () => {
  it("re-exports ignore-preset helpers", () => {
    expect(typeof api.resolveIgnorePresets).toBe("function");
    expect(api.IGNORE_PRESETS).toBeDefined();
    expect(api.IGNORE_PRESETS.analytics).toBeDefined();
  });

  it("re-exports cluster-artifacts surface", () => {
    expect(typeof api.writeClusterArtifacts).toBe("function");
  });

  it("re-exports parity surface", () => {
    expect(typeof api.runParity).toBe("function");
  });
});
