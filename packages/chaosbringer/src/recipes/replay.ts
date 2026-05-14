/**
 * Recipe replay engine. Executes a recipe's serialised steps against
 * a Playwright Page and reports per-step success / failure.
 *
 * Each step has an optional `expectAfter` clause. If it doesn't hold
 * after the step's primary action, replay fails at that index — the
 * caller (driver / verifier) records the failure on the recipe and
 * falls back to the LLM path.
 *
 * Replay is NOT atomic: a failure mid-recipe leaves the page in
 * whatever intermediate state the user's app produced. That's
 * intentional — undoing actions would re-execute logic the recipe is
 * trying to test.
 */
import type { Page } from "playwright";
import type { ExpectClause, ActionRecipe, RecipeStep, ReplayResult } from "./types.js";

const DEFAULT_EXPECT_TIMEOUT_MS = 5000;
/**
 * Bound for raw Playwright action calls. Without this, a missing
 * selector blocks for the Playwright default (30s) on every step and
 * a broken recipe takes minutes to fail. 5s is long enough for SPA
 * reactions on slow CI, short enough to fail fast.
 */
const DEFAULT_ACTION_TIMEOUT_MS = 5000;

export async function runRecipe(page: Page, recipe: ActionRecipe): Promise<ReplayResult> {
  const start = performance.now();
  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i]!;
    try {
      await executeStep(page, step);
    } catch (err) {
      return {
        ok: false,
        durationMs: performance.now() - start,
        failedAt: { index: i, reason: errorMessage(err) },
      };
    }
    if (step.kind !== "wait" && step.kind !== "waitFor" && "expectAfter" in step && step.expectAfter) {
      const ok = await expectHolds(page, step.expectAfter);
      if (!ok) {
        return {
          ok: false,
          durationMs: performance.now() - start,
          failedAt: { index: i, reason: `expectAfter not satisfied: ${describeExpect(step.expectAfter)}` },
        };
      }
    }
  }
  // Postcondition check — verification-mode runners use this to gate
  // promotion. The replayer treats failure here as a replay failure,
  // not a separate concept, because from the caller's point of view a
  // recipe that "succeeded" but left the page in the wrong state is
  // still broken.
  if (recipe.postconditions.length > 0) {
    for (const p of recipe.postconditions) {
      const ok = await expectHolds(page, {
        urlContains: p.urlPattern ? undefined : undefined,
        hasSelector: p.hasSelector,
        hidesSelector: p.hidesSelector,
      });
      if (!ok) {
        return {
          ok: false,
          durationMs: performance.now() - start,
          failedAt: {
            index: recipe.steps.length,
            reason: "postcondition not satisfied",
          },
        };
      }
    }
  }
  return { ok: true, durationMs: performance.now() - start };
}

async function executeStep(page: Page, step: RecipeStep): Promise<void> {
  const timeout = DEFAULT_ACTION_TIMEOUT_MS;
  switch (step.kind) {
    case "navigate":
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout });
      return;
    case "click":
      await page.click(step.selector, { timeout });
      return;
    case "click-at": {
      if (step.viewportHint) {
        const vp = page.viewportSize();
        // If the viewport has changed meaningfully, the coordinates
        // will not land on the original target. Fail fast — better
        // than clicking the wrong thing silently.
        if (
          vp &&
          (Math.abs(vp.width - step.viewportHint.width) > 50 ||
            Math.abs(vp.height - step.viewportHint.height) > 50)
        ) {
          throw new Error(
            `click-at: viewport ${vp.width}x${vp.height} differs from recipe hint ${step.viewportHint.width}x${step.viewportHint.height}`,
          );
        }
      }
      await page.mouse.click(step.x, step.y);
      return;
    }
    case "fill":
      await page.fill(step.selector, step.value, { timeout });
      return;
    case "press":
      if (step.selector) {
        await page.locator(step.selector).press(step.key, { timeout });
      } else {
        await page.keyboard.press(step.key);
      }
      return;
    case "select":
      await page.selectOption(step.selector, step.value, { timeout });
      return;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
    case "waitFor":
      await page.waitForSelector(step.selector, {
        state: "visible",
        timeout: step.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS,
      });
      return;
  }
}

async function expectHolds(page: Page, expect: ExpectClause): Promise<boolean> {
  const timeout = expect.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    let allHold = true;
    if (expect.urlContains !== undefined && !page.url().includes(expect.urlContains)) {
      allHold = false;
    }
    if (allHold && expect.urlNotContains !== undefined && page.url().includes(expect.urlNotContains)) {
      allHold = false;
    }
    if (allHold && expect.hasSelector) {
      const visible = await page
        .locator(expect.hasSelector)
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) allHold = false;
    }
    if (allHold && expect.hidesSelector) {
      const visible = await page
        .locator(expect.hidesSelector)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) allHold = false;
    }
    if (allHold) return true;
    // Poll at 50ms — enough granularity for SPA reactions, cheap enough.
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function describeExpect(e: ExpectClause): string {
  const parts: string[] = [];
  if (e.urlContains) parts.push(`urlContains=${JSON.stringify(e.urlContains)}`);
  if (e.urlNotContains) parts.push(`urlNotContains=${JSON.stringify(e.urlNotContains)}`);
  if (e.hasSelector) parts.push(`hasSelector=${JSON.stringify(e.hasSelector)}`);
  if (e.hidesSelector) parts.push(`hidesSelector=${JSON.stringify(e.hidesSelector)}`);
  return parts.join(", ") || "<empty>";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0]!.slice(0, 200);
  return String(err).slice(0, 200);
}
