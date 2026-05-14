/**
 * `loadPageScenarios` — harvest scenarios that a target app self-declares
 * on `window.__chaosbringer`. Inspired by WebMCP: instead of the testing
 * tool guessing what to do, the app exposes the operations it wants
 * tested. This decouples scenario maintenance from the test harness
 * code — UI rewrites can't silently break scenarios that the app team
 * owns and ships alongside the feature.
 *
 * Shape the app publishes:
 *
 *   ```html
 *   <script>
 *     window.__chaosbringer = {
 *       version: 1,
 *       scenarios: [
 *         {
 *           name: "shop/buy-tshirt",
 *           description: "Add a T-shirt and check out",
 *           goal: "completion",
 *           preconditions: [{ urlPattern: "^/" }],
 *           steps: [
 *             { kind: "click", selector: "[data-test=tshirt]" },
 *             { kind: "click", selector: "[data-test=buy]" }
 *           ],
 *           postconditions: [{ urlPattern: "/thanks" }]
 *         }
 *       ]
 *     };
 *   </script>
 *   ```
 *
 * The shape mirrors `ActionRecipe` so the harvested entries drop
 * straight into a `RecipeStore`. `stats` / `status` / timestamps are
 * filled in here — the app only declares the *intent*, not the runtime
 * metadata.
 *
 * Trust model: harvesting evaluates the page's `window.__chaosbringer`
 * verbatim. **Only run this against your own app or a trusted target.**
 * A hostile page could publish a "scenario" containing a click on a
 * destructive button — replaying it would trigger the destruction.
 * The driver respects this exactly the same way it respects any
 * captured recipe: it's the operator's problem to point the harness
 * at apps they trust.
 */
import type { Page } from "playwright";
import type { ActionRecipe, RecipePrecondition, RecipeStep } from "./types.js";
import { emptyStats } from "./types.js";

export const PAGE_SCENARIO_GLOBAL = "__chaosbringer";

export interface PageDeclaredScenario {
  name: string;
  description?: string;
  goal?: string;
  preconditions?: RecipePrecondition[];
  steps: RecipeStep[];
  postconditions?: RecipePrecondition[];
  requires?: string[];
}

export interface PageDeclaredBundle {
  version?: number;
  scenarios?: PageDeclaredScenario[];
}

export interface LoadPageScenariosOptions {
  /** Override the window global key. Default: `"__chaosbringer"`. */
  globalKey?: string;
  /**
   * Maximum number of scenarios to accept from a single page. Default: 50.
   * Page-declared bundles should be small lists, not full crawler-style
   * dumps; a much larger list signals either a bug or untrusted input.
   */
  maxScenarios?: number;
  /**
   * Set `status: "verified"` on harvested scenarios so they're
   * immediately replayable. Default: false — harvested scenarios
   * start as `candidate` and go through normal verification.
   *
   * Pass true ONLY when the app you target is your own and you've
   * decided the declared scenarios are authoritative.
   */
  trustPublisher?: boolean;
}

/**
 * Read `window.__chaosbringer.scenarios` from the page (if present)
 * and convert each entry into a `candidate`-status `ActionRecipe`.
 * Returns `[]` when nothing is declared or the shape is invalid.
 *
 * Safe to call on any page — invalid / missing globals just return an
 * empty list, never throw.
 */
export async function loadPageScenarios(
  page: Page,
  opts: LoadPageScenariosOptions = {},
): Promise<ActionRecipe[]> {
  const key = opts.globalKey ?? PAGE_SCENARIO_GLOBAL;
  const maxScenarios = opts.maxScenarios ?? 50;

  const bundle = await page
    .evaluate(
      (k: string) => {
        const w = window as unknown as Record<string, unknown>;
        const raw = w[k];
        if (!raw || typeof raw !== "object") return null;
        return raw as unknown;
      },
      key,
    )
    .catch(() => null);

  if (!bundle || typeof bundle !== "object") return [];
  const list = (bundle as PageDeclaredBundle).scenarios;
  if (!Array.isArray(list)) return [];

  const now = Date.now();
  const accepted: ActionRecipe[] = [];
  for (const s of list) {
    if (accepted.length >= maxScenarios) break;
    if (!isValidScenario(s)) continue;
    accepted.push({
      name: s.name,
      description: s.description ?? `Page-declared scenario "${s.name}"`,
      goal: s.goal,
      preconditions: s.preconditions ?? [],
      steps: s.steps,
      postconditions: s.postconditions ?? [],
      requires: s.requires ?? [],
      stats: emptyStats(),
      origin: "page-declared",
      status: opts.trustPublisher ? "verified" : "candidate",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  return accepted;
}

/**
 * Validation gate. We accept "looks structurally right" — strict
 * step-kind validation lives in the replay layer, which gives a
 * better error message on actual misuse anyway.
 */
function isValidScenario(s: unknown): s is PageDeclaredScenario {
  if (!s || typeof s !== "object") return false;
  const v = s as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return false;
  if (!Array.isArray(v.steps) || v.steps.length === 0) return false;
  // Sanity: every step must be an object with a string `kind`. We
  // accept anything past that — the replayer's switch handles invalid
  // kinds by throwing at execution time.
  for (const step of v.steps) {
    if (!step || typeof step !== "object") return false;
    if (typeof (step as Record<string, unknown>).kind !== "string") return false;
  }
  return true;
}
