/**
 * Precondition matching. Pure-ish: takes a Page + preconditions, returns
 * a boolean. Selector visibility checks are bounded by a 100ms timeout
 * so a slow selector doesn't block driver decision time.
 *
 * Why no custom predicate function: recipes are JSON-only by design
 * (review-able in PRs, shareable across projects). A function field
 * would re-introduce `eval`-shaped code paths and defeat that.
 */
import type { Page } from "playwright";
import type { RecipePrecondition } from "./types.js";

const PRECOND_TIMEOUT_MS = 100;

export async function preconditionsHold(
  page: Page,
  preconditions: ReadonlyArray<RecipePrecondition>,
): Promise<boolean> {
  for (const p of preconditions) {
    if (!(await preconditionHolds(page, p))) return false;
  }
  return true;
}

async function preconditionHolds(page: Page, p: RecipePrecondition): Promise<boolean> {
  if (p.urlPattern) {
    let re: RegExp;
    try {
      re = new RegExp(p.urlPattern);
    } catch {
      // Bad regex in a recipe → treat as non-matching rather than throwing.
      return false;
    }
    if (!re.test(page.url())) return false;
  }
  if (p.hasSelector) {
    try {
      await page.waitForSelector(p.hasSelector, { state: "visible", timeout: PRECOND_TIMEOUT_MS });
    } catch {
      return false;
    }
  }
  if (p.hidesSelector) {
    try {
      const visible = await page.locator(p.hidesSelector).first().isVisible({ timeout: PRECOND_TIMEOUT_MS }).catch(() => false);
      if (visible) return false;
    } catch {
      // If we can't determine visibility, conservatively assume the
      // selector is visible (so the precondition fails). Better to
      // skip the recipe than misfire it.
      return false;
    }
  }
  return true;
}
