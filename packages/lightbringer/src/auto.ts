// Auto-span fixture: measure an EXISTING Playwright spec with (almost) no edits.
// Swap `import { test, expect } from "@playwright/test"` for
// `import { test, expect } from "lightbringer/auto"` and every page navigation /
// interaction (page.goto, and Locator actions like getByRole(...).click()) becomes
// a measured span automatically — no perf.measure() calls in the spec body.
//
// Caveat vs. explicit perf.measure: each span covers one action's own cost (action
// + a short settle), NOT "until your next assertion". For "until settled" windows,
// use the explicit `test` from "lightbringer" and perf.measure().
//
// This is a thin entry: a *direct* import resolves @playwright/test to the
// consumer's single install, so value-importing it here is safe. The
// instrumentation itself lives in ./autowrap, which is type-only on @playwright/test
// so the CLI's spec-mode loader can pull it in without loading a second Playwright
// (see src/autowrap.ts and src/cli.ts).
import { test as base } from "@playwright/test";
import { autoWrap } from "./autowrap";

export const test = autoWrap(base);
export { autoWrap } from "./autowrap";
export { expect } from "@playwright/test";
