// The @playwright/test fixture (`lightbringer/fixture`, re-exported from `.`).
// The only module besides auto.ts that value-imports @playwright/test, so the
// core (`lightbringer/core`) and the CLI stay free of it. PERF_* env vars are
// mapped onto session options by sessionOptionsFromEnv (in ./test-edge).
import { test as base } from "@playwright/test";
import type { PerfController } from "./controller";
import { runTestSession } from "./test-edge";

export const test = base.extend<{ perf: PerfController }>({
  perf: async ({ page }, use, testInfo) => {
    await runTestSession(page, testInfo, (session) => use(session.controller));
  },
});

export { expect } from "@playwright/test";
