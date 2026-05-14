/**
 * `investigate()` — Phase D of the AI flywheel.
 *
 * Given a captured `FailureContext`, opens a fresh browser, navigates
 * to the failure URL, and lets an AI `Driver` poke around (wrapped in
 * a `tracingDriver`) trying to reproduce the failure as compactly as
 * possible. When the goal's `successCheck` flips true the resulting
 * trace becomes a `regression`-origin `ActionRecipe` and lands in the
 * store, ready to be replayed under every future chaos / load run.
 *
 * This runner is intentionally NOT the full `ChaosCrawler`. We don't
 * need invariant tracking, error clustering, traceparent injection,
 * or HAR replay — we need ONE loop that fires actions and notices
 * when the bug comes back. The minimal candidate enumerator
 * (`discoverCandidates`) reflects that scope: visible buttons /
 * links / inputs only, no weighting.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { createRng, type Rng } from "../random.js";
import type { ActionResult } from "../types.js";
import type {
  Driver,
  DriverCandidate,
  DriverPick,
  DriverStep,
} from "../drivers/types.js";
import { extractCandidate } from "./capture.js";
import { investigateGoal, type FailureContext } from "./goals.js";
import { minimizeRecipeTrace } from "./minimize.js";
import type { RecipeStore } from "./store.js";
import { tracingDriver, type TracingDriver } from "./tracing-driver.js";
import type { ActionRecipe, ActionTrace, Goal } from "./types.js";

export interface InvestigateOptions {
  /** The failure to reproduce. Its `url` is where we start. */
  failure: FailureContext;
  /**
   * The AI driver to use (usually an `aiDriver` wired to an
   * Anthropic / OpenRouter provider). Wrapped internally by
   * `tracingDriver` — DON'T wrap it yourself.
   */
  driver: Driver;
  /** Store the resulting regression recipe lands in on success. */
  store: RecipeStore;
  /** Override the goal (and its successCheck). Default: `investigateGoal(failure)`. */
  goal?: Goal;
  /** Max actions to spend. Default: 20. */
  budget?: number;
  /** Default: true. */
  headless?: boolean;
  /** Allow caller to inject a pre-launched browser. We don't close it if so. */
  browser?: Browser;
  /** Seed for the internal Rng (drivers that randomise consume this). */
  seed?: number;
  /**
   * Naming strategy for the produced recipe. Default:
   * `regression/<failure.signature>`.
   */
  recipeName?: (failure: FailureContext) => string;
  /**
   * `extractCandidate` options. The runner sets `name`, `description`,
   * `goal`, `origin: "regression"` automatically; pass `inferUrlPreconditions`
   * etc. through this.
   */
  captureExtras?: Parameters<typeof extractCandidate>[1] extends infer T
    ? Omit<
        Extract<T, { name: string }>,
        "name" | "description" | "origin" | "requires"
      >
    : never;
  /** Verbose log on `console.log`. Default: false. */
  verbose?: boolean;
  /**
   * After reproduction, delta-debug the captured trace to the
   * 1-minimal subset. Costs up to N² extra replays for an N-step
   * trace, so opt-in. The stored regression recipe contains the
   * minimised steps; `trace.steps` reflects the raw AI trajectory.
   */
  minimize?: boolean;
  /**
   * Cap on minimisation replays. Default: `trace.steps.length²`.
   * Lower to bound cost on long traces.
   */
  minimizeMaxReplays?: number;
}

export interface InvestigateResult {
  reproduced: boolean;
  /** The captured recipe (also persisted via `store.upsert`). */
  recipe: ActionRecipe | null;
  trace: ActionTrace;
  /** Wall-clock spent across all steps. */
  durationMs: number;
}

export async function investigate(opts: InvestigateOptions): Promise<InvestigateResult> {
  const log = opts.verbose ? (m: string) => console.log(`[investigate] ${m}`) : () => {};
  const goal = opts.goal ?? investigateGoal(opts.failure);
  const budget = opts.budget ?? goal.budget?.maxSteps ?? 20;
  const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const rng = createRng(seed);
  const ownsBrowser = opts.browser === undefined;
  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true }));
  const context = await browser.newContext();
  const page = await context.newPage();

  const tracing = tracingDriver({ inner: opts.driver, goal });
  const startedAt = Date.now();

  // Install error hooks BEFORE the initial navigation — `console.error`
  // calls in page-load scripts fire before any selectAction can run, so
  // delegating error capture to tracingDriver (which hooks on first
  // selectAction) would miss them.
  const errors: Array<{ message: string; timestamp: number }> = [];
  page.on("pageerror", (err) => {
    errors.push({ message: err.message, timestamp: Date.now() });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push({ message: msg.text(), timestamp: Date.now() });
    }
  });

  const checkGoal = async (): Promise<boolean> => {
    const trace = tracing.getTrace();
    return goal
      .successCheck({
        page,
        url: page.url(),
        history: trace.steps,
        errors,
      })
      .catch(() => false);
  };

  const finaliseTrace = (): void => {
    const trace = tracing.getTrace();
    if (trace.successful) return;
    trace.successful = true;
    trace.endState = { url: page.url() };
    trace.durationMs = Date.now() - startedAt;
  };

  try {
    await page.goto(opts.failure.url, { waitUntil: "domcontentloaded" });

    // Materialise the trace with the post-navigation URL so the
    // capture step sees a valid `startState.url`. Without this, an
    // initial-load reproduction has a blank start URL and
    // `extractCandidate` (which `new URL(...)`s it) throws.
    {
      const trace = tracing.getTrace();
      trace.startState = { url: page.url() };
      trace.endState = { url: page.url() };
    }

    // Check the load-time state first — if the failure already
    // reproduces on the unchanged page (a flaky page-load console
    // error, say), no actions are needed. We synthesise a single
    // `navigate` step so the regression recipe is still meaningful:
    // replaying it = visiting the URL = re-triggering the bug.
    if (await checkGoal()) {
      log(`reproduced on initial load`);
      const trace = tracing.getTrace();
      if (trace.steps.length === 0) {
        trace.steps.push({ kind: "navigate", url: opts.failure.url });
      }
      finaliseTrace();
    }

    for (let stepIndex = 0; stepIndex < budget && !tracing.getTrace().successful; stepIndex++) {
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
        log(`driver yielded at step ${stepIndex}`);
        break;
      }
      if (candidates.length === 0 && pick.kind === "select") {
        log("no candidates and pick is select — exiting");
        break;
      }

      const action = await executePick(page, pick, driverStep);
      tracing.onActionComplete?.(action, driverStep);
      log(`step ${stepIndex}: ${action.type}${action.selector ? ` ${action.selector}` : ""}${action.success ? " ok" : " FAIL"}`);

      // Poll the goal AFTER each action — the post-action state is
      // where reproduction lives. This is the moment that turns the
      // run successful.
      if (await checkGoal()) {
        log(`reproduced after ${stepIndex + 1} steps`);
        finaliseTrace();
        break;
      }
    }

    const trace = tracing.getTrace();
    let recipe: ActionRecipe | null = null;

    if (trace.successful && trace.steps.length > 0) {
      const name = (opts.recipeName ?? defaultRecipeName)(opts.failure);
      const description = `Regression: ${opts.failure.notes ?? opts.failure.signature}`;

      // Optional delta-debugging step: shrink the trace before
      // committing it to the store. The raw trace is still surfaced
      // on the InvestigateResult; only the recipe is minimised.
      let recipeSteps = trace.steps;
      if (opts.minimize && trace.steps.length > 1) {
        const setupPage = async (): Promise<{ page: Page; cleanup: () => Promise<void> }> => {
          const ctx = await browser.newContext();
          const pg = await ctx.newPage();
          await pg.goto(opts.failure.url, { waitUntil: "domcontentloaded" });
          return { page: pg, cleanup: () => ctx.close() };
        };
        const minimized = await minimizeRecipeTrace({
          trace,
          goal,
          setupPage,
          maxReplays: opts.minimizeMaxReplays,
          verbose: opts.verbose,
        }).catch((err) => {
          log(`minimize threw: ${(err as Error).message}`);
          return null;
        });
        if (minimized) {
          log(
            `minimised ${minimized.originalLength} → ${minimized.minimizedLength} steps (${minimized.replays} replays, ${minimized.reason})`,
          );
          recipeSteps = minimized.steps;
        }
      }

      const recipeTrace: ActionTrace = { ...trace, steps: recipeSteps };
      recipe = extractCandidate(recipeTrace, {
        name,
        description,
        origin: "regression",
        ...((opts.captureExtras as Record<string, unknown>) ?? {}),
      });
      opts.store.upsert(recipe);
      log(`stored ${name} (${recipeSteps.length} step(s))`);
    } else {
      log(`gave up — reproduced=${trace.successful}, steps=${trace.steps.length}`);
    }

    return {
      reproduced: trace.successful,
      recipe,
      trace,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await context.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}

function defaultRecipeName(failure: FailureContext): string {
  return `regression/${failure.signature.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

/**
 * Minimal candidate enumerator. Returns up to `MAX_CANDIDATES` of the
 * page's visible interactive elements with stable selectors. Stable
 * selector strategy (in priority order):
 *
 *   1. `data-testid` / `data-test*`
 *   2. `id`
 *   3. `aria-label`
 *   4. tag + visible text (`button:has-text("Buy")`)
 *   5. nth-position of the tag among siblings (fallback)
 *
 * This is a lot less thorough than the crawler's candidate selector,
 * but the investigation flow only needs "click any of these" — the
 * AI does the rest. The crawler-grade discovery can be a follow-up
 * if AI accuracy needs lifting.
 */
const MAX_CANDIDATES = 30;

export async function discoverCandidates(page: Page): Promise<DriverCandidate[]> {
  const handles = await page
    .locator('a:visible, button:visible, [role="button"]:visible, input:visible, textarea:visible, select:visible')
    .all();
  const out: DriverCandidate[] = [];
  for (const handle of handles) {
    if (out.length >= MAX_CANDIDATES) break;
    const info = await summariseLocator(handle).catch(() => null);
    if (!info) continue;
    out.push({
      index: out.length,
      selector: info.selector,
      description: info.description,
      type: info.type,
      weight: 1,
    });
  }
  return out;
}

interface CandidateInfo {
  selector: string;
  description: string;
  type: DriverCandidate["type"];
}

async function summariseLocator(loc: Locator): Promise<CandidateInfo | null> {
  return loc.evaluate((el) => {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return null;
    const tag = el.tagName.toLowerCase();
    let selector: string | null = null;
    // Priority 1: data-testid / data-test*
    for (const attr of el.getAttributeNames()) {
      if (/^data-test(id)?$/.test(attr)) {
        selector = `[${attr}="${cssEscape(el.getAttribute(attr) ?? "")}"]`;
        break;
      }
    }
    // Priority 2: id
    if (!selector && el.id) selector = `#${cssEscape(el.id)}`;
    // Priority 3: aria-label
    if (!selector) {
      const aria = el.getAttribute("aria-label");
      if (aria) selector = `${tag}[aria-label="${cssEscape(aria)}"]`;
    }
    // Priority 4: tag + visible text (only for elements with text content)
    if (!selector && el.textContent) {
      const text = el.textContent.trim().slice(0, 40);
      if (text && (tag === "a" || tag === "button")) {
        selector = `${tag}:has-text(${JSON.stringify(text)})`;
      }
    }
    // Priority 5: nth-of-type fallback
    if (!selector) {
      const parent = el.parentElement;
      if (!parent) return null;
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === el.tagName,
      );
      const idx = siblings.indexOf(el);
      selector = `${tag}:nth-of-type(${idx + 1})`;
    }

    let type: "link" | "button" | "input" = "button";
    if (tag === "a") type = "link";
    else if (tag === "input" || tag === "textarea" || tag === "select") type = "input";

    const text = (el.textContent ?? "").trim().slice(0, 80);
    const aria = el.getAttribute("aria-label") ?? "";
    const description = `<${tag}> ${aria || text}`.trim();

    return { selector, description, type } as CandidateInfo;

    function cssEscape(value: string): string {
      return value.replace(/["\\]/g, "\\$&");
    }
  });
}

async function executePick(
  page: Page,
  pick: DriverPick,
  step: DriverStep,
): Promise<ActionResult> {
  const ts = Date.now();
  if (pick.kind === "skip") {
    return { type: "click", success: false, timestamp: ts, error: "skipped" };
  }
  if (pick.kind === "custom") {
    try {
      return await pick.perform(page);
    } catch (err) {
      return {
        type: "click",
        success: false,
        timestamp: ts,
        error: messageOf(err),
      };
    }
  }
  const candidate = step.candidates[pick.index];
  if (!candidate) {
    return {
      type: "click",
      success: false,
      timestamp: ts,
      error: `no candidate at index ${pick.index}`,
    };
  }
  try {
    if (candidate.type === "input") {
      await page.fill(candidate.selector, "test input", { timeout: 3000 });
      return {
        type: "input",
        selector: candidate.selector,
        target: "test input",
        success: true,
        timestamp: ts,
      };
    }
    await page.click(candidate.selector, { timeout: 3000 });
    return {
      type: "click",
      selector: candidate.selector,
      success: true,
      timestamp: ts,
    };
  } catch (err) {
    return {
      type: "click",
      selector: candidate.selector,
      success: false,
      timestamp: ts,
      error: messageOf(err),
    };
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0]!.slice(0, 200);
  return String(err).slice(0, 200);
}

// Re-export so callers can build their own tracing wrapper alongside.
export { tracingDriver, type TracingDriver };
