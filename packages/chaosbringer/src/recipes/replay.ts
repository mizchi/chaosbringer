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
import { hasTemplates, substituteSteps, type RecipeVars } from "./templating.js";

const DEFAULT_EXPECT_TIMEOUT_MS = 5000;
/**
 * Bound for raw Playwright action calls. Without this, a missing
 * selector blocks for the Playwright default (30s) on every step and
 * a broken recipe takes minutes to fail. 5s is long enough for SPA
 * reactions on slow CI, short enough to fail fast.
 */
const DEFAULT_ACTION_TIMEOUT_MS = 5000;

export interface RunRecipeOptions {
  /**
   * Variable bag for template substitution. Templated values in
   * recipe steps (`{{email}}` etc.) are resolved against this map
   * before each step executes. Throws if a referenced variable is
   * missing — silent fallback would let typos bypass form fills.
   */
  vars?: RecipeVars;
  /**
   * The site to replay against. A recipe keeps the absolute URLs it was
   * recorded with, so without this one made on localhost replays on
   * localhost whatever host the caller meant to test. With it, the
   * recipe's own URLs move onto this URL's origin; see `rebaseRecipe`.
   * Throws when it is not an absolute http(s) URL.
   */
  baseUrl?: string;
}

export async function runRecipe(
  page: Page,
  recipe: ActionRecipe,
  opts: RunRecipeOptions = {},
): Promise<ReplayResult> {
  const start = performance.now();
  // Rebased before substitution: a `{{var}}` is not part of any origin,
  // and a substituted value is the caller's, not the recording's.
  const rebased = opts.baseUrl ? rebaseRecipe(recipe, opts.baseUrl) : recipe;
  const steps = opts.vars ? substituteSteps(rebased.steps, opts.vars) : rebased.steps;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
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
            index: steps.length,
            reason: "postcondition not satisfied",
          },
        };
      }
    }
  }
  return { ok: true, durationMs: performance.now() - start };
}

/**
 * The origin a recipe was recorded on: its first step's, when that is a
 * navigate to an absolute http(s) URL (`drive` always starts with one).
 * A recipe that starts on the page it matched on (a click, a fill) has
 * only its first precondition to say where that was, when its
 * `urlPattern` spells out a scheme and host (`^https://shop\.test/cart`).
 * Never a later navigate: that is where the recipe went (a payment
 * provider, an SSO page), not where it was recorded. `null` when nothing
 * names the site, or the first navigate templates it (`{{base}}/`,
 * `http://{{host}}/`) — the caller's vars name it then, not the recording.
 */
export function recipeOrigin(
  recipe: Pick<ActionRecipe, "steps"> & Partial<Pick<ActionRecipe, "preconditions">>,
): string | null {
  const first = recipe.steps[0];
  const origin =
    first?.kind === "navigate" ? httpOrigin(first.url) : patternOrigin(recipe.preconditions?.[0]?.urlPattern);
  return origin && !hasTemplates(origin) ? origin : null;
}

/**
 * The origin a `urlPattern` regex source starts with, its escapes (`\.`,
 * `\/`, `\:`, `\-`) read as the characters they stand for. `null` when
 * it does not start with a literal scheme and host: `https?://`, a
 * `[a-z]+` or `\d+` in the host, or a host a quantifier ends on.
 */
function patternOrigin(pattern: string | undefined): string | null {
  const head = pattern
    ? /^\^?(https?:(?:\\?\/){2}(?:\\[.:-]|[^/\\?#()[\]{}|*+^$])+)(?:$|\/|\\\/|\$)/i.exec(pattern)?.[1]
    : undefined;
  return head ? httpOrigin(head.replace(/\\(.)/g, "$1")) : null;
}

/**
 * `recipe` replayed on `baseUrl`'s site: every navigate to the recipe's
 * recorded origin (`recipeOrigin`) goes to `baseUrl`'s origin instead,
 * path, query, hash and any `{{var}}` in them kept as written, and so do
 * the `urlContains` / `urlNotContains` expectations that spell that
 * origin out. Only the origin moves, never a path prefix: a base URL is
 * often a start page (`https://staging.test/login`), not a mount point.
 * A navigate to another origin (a payment provider, an SSO page) is left
 * alone, and so is every step of a recipe with no recorded origin. Saved
 * recipes are not rewritten — this happens at replay.
 */
export function rebaseRecipe(recipe: ActionRecipe, baseUrl: string): ActionRecipe {
  const to = httpOrigin(baseUrl);
  if (!to) throw new Error(`rebaseRecipe: base URL ${JSON.stringify(baseUrl)} is not an absolute http(s) URL`);
  const from = recipeOrigin(recipe);
  if (!from || from === to) return recipe;
  return { ...recipe, steps: recipe.steps.map((s) => rebaseStep(s, from, to)) };
}

/**
 * The warning a CLI prints when `baseUrl` moves `recipe` off the origin
 * it was recorded on; `null` when it does not move it.
 */
export function rebaseNotice(recipe: ActionRecipe, baseUrl: string): string | null {
  const from = recipeOrigin(recipe);
  const to = httpOrigin(baseUrl);
  if (!from || !to || from === to) return null;
  return `${recipe.name} was recorded on ${from}; replaying it on ${to} instead`;
}

function rebaseStep(step: RecipeStep, from: string, to: string): RecipeStep {
  let out = step;
  if (step.kind === "navigate" && httpOrigin(step.url) === from) {
    // Rewritten as text, not through `URL`: that would percent-encode
    // the braces of a `{{var}}` in the path and break the template.
    const authority = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i.exec(step.url);
    if (authority) out = { ...step, url: to + step.url.slice(authority[0].length) };
  }
  if (out.kind === "wait" || out.kind === "waitFor" || !out.expectAfter) return out;
  const expect = out.expectAfter;
  const urlContains = swapOrigin(expect.urlContains, from, to);
  const urlNotContains = swapOrigin(expect.urlNotContains, from, to);
  if (urlContains === expect.urlContains && urlNotContains === expect.urlNotContains) return out;
  return {
    ...out,
    expectAfter: {
      ...expect,
      ...(urlContains !== undefined ? { urlContains } : {}),
      ...(urlNotContains !== undefined ? { urlNotContains } : {}),
    },
  };
}

/** `text` with a leading `from` origin replaced by `to`; anything else as is. */
function swapOrigin(text: string | undefined, from: string, to: string): string | undefined {
  if (text === undefined || !text.startsWith(from)) return text;
  const next = text.charAt(from.length);
  return next === "" || "/?#".includes(next) ? to + text.slice(from.length) : text;
}

function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
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
