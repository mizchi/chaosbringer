/**
 * `repairRecipe` — when a verified recipe starts failing at step N
 * (because the app's UI changed), instead of demoting and re-running
 * full Phase A discovery, hand the partial recipe to an AI driver
 * and let it propose a fix for the broken tail.
 *
 * Strategy:
 *   1. Replay the recipe step-by-step until it fails. The page is now
 *      in the state at which the OLD recipe used to keep going.
 *   2. From there, run the AI driver against a `repairGoal` whose
 *      `successCheck` is the **original recipe's postconditions** —
 *      i.e. the AI's job is to reach the same final state, by
 *      whatever means.
 *   3. Capture the AI's trace, splice it onto the prefix that worked,
 *      bump `version`, and re-upsert. The original stats carry over —
 *      a long-running recipe with 7 historical successes shouldn't
 *      drop to zero just because one step needed editing.
 *
 * This is browser-harness's self-modifying philosophy applied to
 * static recipes: skills survive UI churn instead of getting blown
 * away.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { createRng } from "../random.js";
import type { Driver, DriverStep } from "../drivers/types.js";
import { discoverCandidates } from "./investigate.js";
import { runRecipe } from "./replay.js";
import type { RecipeStore } from "./store.js";
import { tracingDriver, type TracingDriver } from "./tracing-driver.js";
import type {
  ActionRecipe,
  ActionTrace,
  Goal,
  GoalContext,
  RecipePrecondition,
  RecipeStep,
} from "./types.js";

export interface RepairOptions {
  /** Verified recipe whose replay is failing. */
  recipe: ActionRecipe;
  /** Store the patched recipe is upserted into on success. */
  store: RecipeStore;
  /** AI driver used to figure out the new tail. */
  driver: Driver;
  /**
   * Where to start the replay. Default: re-derived from the recipe's
   * first `navigate` step, or `baseUrl + "/"` if there's no leading
   * navigate.
   */
  startUrl?: string;
  /** Same shape `investigate()` accepts. */
  baseUrl?: string;
  /** Headless. Default: true. */
  headless?: boolean;
  /** Caller-supplied browser to amortise launches. */
  browser?: Browser;
  /** Max repair steps to spend AFTER the failing step. Default: 15. */
  repairBudget?: number;
  /** Seed for the inner Rng. */
  seed?: number;
  /** Verbose log on `console.log`. */
  verbose?: boolean;
}

export interface RepairResult {
  /** True when the AI produced a working tail and the store was updated. */
  repaired: boolean;
  /** Index of the step that originally failed (0-based). */
  failedAt: number;
  /** Number of steps the AI contributed (after the prefix). */
  newTailSteps: number;
  /** Updated recipe, if repaired. */
  recipe: ActionRecipe | null;
  /** The trace captured during repair, for debugging. */
  trace: ActionTrace;
}

export async function repairRecipe(opts: RepairOptions): Promise<RepairResult> {
  const log = opts.verbose
    ? (m: string) => console.log(`[repair ${opts.recipe.name}] ${m}`)
    : () => {};
  const ownsBrowser = opts.browser === undefined;
  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true }));
  const context = await browser.newContext();
  const page = await context.newPage();
  const startUrl = opts.startUrl ?? deriveStartUrl(opts.recipe, opts.baseUrl);

  // Build a Goal whose successCheck = original postconditions held.
  const goal = postconditionGoal(opts.recipe);
  const tracing = tracingDriver({ inner: opts.driver, goal });

  // Tracing trace will start fresh — we'll splice the AI-discovered
  // tail onto the OLD prefix manually so the AI's steps are clearly
  // distinguished from the kept ones.
  let failedAt = opts.recipe.steps.length; // assume all good unless replay says otherwise
  let prefix: RecipeStep[] = [];
  let aiTail: RecipeStep[] = [];

  const cleanup = async (): Promise<void> => {
    await context.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  };

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });

    // Phase 1: identify where the recipe currently breaks. We don't
    // need to call runRecipe end-to-end — we replay step-by-step so
    // we can stop exactly at the failing step.
    for (let i = 0; i < opts.recipe.steps.length; i++) {
      const partial: ActionRecipe = {
        ...opts.recipe,
        steps: [opts.recipe.steps[i]!],
        // Strip postconditions while probing — they are the END check.
        postconditions: [],
      };
      const result = await runRecipe(page, partial);
      if (!result.ok) {
        failedAt = i;
        log(`step ${i} (${opts.recipe.steps[i]!.kind}) failed: ${result.failedAt?.reason}`);
        break;
      }
      prefix.push(opts.recipe.steps[i]!);
    }

    if (failedAt >= opts.recipe.steps.length) {
      log("no failure detected — recipe is fine, nothing to repair");
      return {
        repaired: false,
        failedAt: opts.recipe.steps.length,
        newTailSteps: 0,
        recipe: null,
        trace: tracing.getTrace(),
      };
    }

    // Phase 2: hand the page (now in the post-prefix state) to the AI
    // driver. Loop until goal is satisfied or budget runs out.
    const budget = opts.repairBudget ?? 15;
    const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const rng = createRng(seed);

    for (let stepIndex = 0; stepIndex < budget; stepIndex++) {
      // Goal check first — if we landed on the success state
      // immediately after the prefix (e.g. failing step was a
      // no-op), declare repair complete with zero new steps.
      const goalCtx: GoalContext = {
        page,
        url: page.url(),
        history: tracing.getTrace().steps,
        errors: [],
      };
      const ok = await goal.successCheck(goalCtx).catch(() => false);
      if (ok) {
        tracing.getTrace().successful = true;
        log(`repaired at step +${stepIndex}`);
        break;
      }

      const candidates = await discoverCandidates(page);
      const driverStep: DriverStep = {
        url: page.url(),
        page,
        candidates,
        history: [],
        stepIndex,
        rng,
        screenshot: (mode) =>
          page.screenshot({ fullPage: mode === "fullPage" }).then((buf) => Buffer.from(buf)),
        invariantViolations: [],
      };

      const pick = await tracing.selectAction(driverStep);
      if (!pick || pick.kind === "skip") {
        log(`driver yielded at +${stepIndex}`);
        break;
      }
      const action = await executePick(page, pick, driverStep);
      tracing.onActionComplete?.(action, driverStep);
      log(`+${stepIndex}: ${action.type}${action.selector ? ` ${action.selector}` : ""}${action.success ? " ok" : " FAIL"}`);
    }

    aiTail = tracing.getTrace().steps;
    const trace = tracing.getTrace();

    if (!trace.successful || aiTail.length === 0) {
      log("AI did not converge — leaving recipe unchanged");
      return {
        repaired: false,
        failedAt,
        newTailSteps: aiTail.length,
        recipe: null,
        trace,
      };
    }

    // Phase 3: splice + upsert. Preserve stats (the historical wins
    // are still informative) but bump version.
    const repaired: ActionRecipe = {
      ...opts.recipe,
      steps: [...prefix, ...aiTail],
      version: opts.recipe.version + 1,
      updatedAt: Date.now(),
      // Keep `origin` — repaired-from-ai-extracted is still
      // ai-extracted in spirit. Add a discriminator via `requires`
      // for callers who need provenance.
      requires: [
        ...opts.recipe.requires,
        `__repaired-from-v${opts.recipe.version}`,
      ],
    };
    opts.store.upsert(repaired);
    log(`upserted v${repaired.version} (prefix=${prefix.length}, tail=${aiTail.length})`);
    return {
      repaired: true,
      failedAt,
      newTailSteps: aiTail.length,
      recipe: repaired,
      trace,
    };
  } finally {
    await cleanup();
  }
}

function deriveStartUrl(recipe: ActionRecipe, baseUrl?: string): string {
  const firstNav = recipe.steps.find((s) => s.kind === "navigate");
  if (firstNav && firstNav.kind === "navigate") return firstNav.url;
  if (baseUrl) return baseUrl;
  // Last resort — pull the host from the first urlPattern.
  const pattern = recipe.preconditions[0]?.urlPattern;
  if (pattern) {
    const match = /https?:\\?\/\\?\/[^/\\]+/.exec(pattern);
    if (match) return match[0].replace(/\\\//g, "/").replace(/\\\./g, ".");
  }
  throw new Error("repairRecipe: cannot derive startUrl. Pass `startUrl` or `baseUrl`.");
}

/**
 * A Goal whose successCheck is `runRecipe`'s postcondition check.
 * The AI's job is to reach the original recipe's intended end state,
 * not to follow the original path.
 */
function postconditionGoal(recipe: ActionRecipe): Goal {
  const conds = recipe.postconditions;
  return {
    name: "repair",
    persona:
      "a maintenance engineer patching a regression in an existing automation — preserve the original intent, change only what UI churn forced",
    objective: `The recipe "${recipe.name}" used to work; one of its steps broke. Reach the same end state (postconditions: ${describeConds(conds)}) using the smallest number of replacement actions.`,
    successCheck: async (ctx: GoalContext) => {
      for (const c of conds) {
        if (!(await condHolds(ctx, c))) return false;
      }
      return conds.length > 0;
    },
  };
}

async function condHolds(ctx: GoalContext, c: RecipePrecondition): Promise<boolean> {
  if (c.urlPattern) {
    try {
      if (!new RegExp(c.urlPattern).test(ctx.url)) return false;
    } catch {
      return false;
    }
  }
  if (c.hasSelector) {
    const visible = await ctx.page
      .locator(c.hasSelector)
      .first()
      .isVisible({ timeout: 200 })
      .catch(() => false);
    if (!visible) return false;
  }
  if (c.hidesSelector) {
    const visible = await ctx.page
      .locator(c.hidesSelector)
      .first()
      .isVisible({ timeout: 200 })
      .catch(() => false);
    if (visible) return false;
  }
  return true;
}

function describeConds(conds: ReadonlyArray<RecipePrecondition>): string {
  if (conds.length === 0) return "(none)";
  return conds
    .map((c) => {
      const parts: string[] = [];
      if (c.urlPattern) parts.push(`url~/${c.urlPattern}/`);
      if (c.hasSelector) parts.push(`visible:${c.hasSelector}`);
      if (c.hidesSelector) parts.push(`hidden:${c.hidesSelector}`);
      return parts.join(" + ");
    })
    .join(", ");
}

// Re-use the execute helper from investigate; keeping it private to
// investigate avoids exposing a partial driver-step executor in the
// public API.
async function executePick(
  page: Page,
  pick: import("../drivers/types.js").DriverPick,
  step: DriverStep,
): Promise<import("../types.js").ActionResult> {
  const ts = Date.now();
  if (pick.kind === "skip") {
    return { type: "click", success: false, timestamp: ts, error: "skipped" };
  }
  if (pick.kind === "custom") {
    try {
      return await pick.perform(page);
    } catch (err) {
      return { type: "click", success: false, timestamp: ts, error: messageOf(err) };
    }
  }
  const candidate = step.candidates[pick.index];
  if (!candidate) {
    return { type: "click", success: false, timestamp: ts, error: `no candidate ${pick.index}` };
  }
  try {
    if (candidate.type === "input") {
      await page.fill(candidate.selector, "test input", { timeout: 3000 });
      return { type: "input", selector: candidate.selector, target: "test input", success: true, timestamp: ts };
    }
    await page.click(candidate.selector, { timeout: 3000 });
    return { type: "click", selector: candidate.selector, success: true, timestamp: ts };
  } catch (err) {
    return { type: "click", selector: candidate.selector, success: false, timestamp: ts, error: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0]!.slice(0, 200);
  return String(err).slice(0, 200);
}

// Suppress unused-import warning for the BrowserContext type — it's
// part of the public surface even if not referenced directly here.
void ({} as BrowserContext);
// And the tracing helper export — typed for symmetry.
export type { TracingDriver };
