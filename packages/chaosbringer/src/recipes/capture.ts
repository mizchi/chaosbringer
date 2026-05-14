/**
 * Trace → candidate recipe. Takes a successful ActionTrace and packages
 * it as a candidate `ActionRecipe` for the store.
 *
 * Preconditions / postconditions are inferred conservatively:
 * - precondition is `urlPattern` matching the *start* URL (escaped)
 * - postcondition is `urlPattern` matching the *end* URL (escaped),
 *   when start ≠ end. Same URL means "in-place action" and we don't
 *   over-constrain.
 *
 * Callers can pass `extraPreconditions` / `extraPostconditions` to
 * tighten — useful when you know "this only applies on the cart page
 * if the cart has ≥ 1 item".
 */
import type { ActionRecipe, ActionTrace, RecipePrecondition, RecipeStep } from "./types.js";
import { emptyStats } from "./types.js";

export interface ExtractCandidateOptions {
  name: string;
  description: string;
  origin?: ActionRecipe["origin"];
  requires?: string[];
  /** Tightening preconditions added to the auto-inferred URL precondition. */
  extraPreconditions?: RecipePrecondition[];
  extraPostconditions?: RecipePrecondition[];
  /**
   * If true (default), the URL of the starting page is used as a
   * `urlPattern` precondition. Set false when you want the recipe to
   * be URL-agnostic (e.g. global navbar interactions).
   */
  inferUrlPreconditions?: boolean;
}

export function extractCandidate(
  trace: ActionTrace,
  options: ExtractCandidateOptions,
): ActionRecipe {
  if (!trace.successful) {
    throw new Error(`extractCandidate: refusing to extract from unsuccessful trace (goal=${trace.goal})`);
  }
  if (trace.steps.length === 0) {
    throw new Error(`extractCandidate: trace has no steps (goal=${trace.goal})`);
  }

  const inferUrl = options.inferUrlPreconditions !== false;
  const preconditions: RecipePrecondition[] = [
    ...(inferUrl ? [{ urlPattern: escapePathForRegex(new URL(trace.startState.url).pathname) }] : []),
    ...(options.extraPreconditions ?? []),
  ];
  const postconditions: RecipePrecondition[] =
    trace.endState.url !== trace.startState.url
      ? [
          { urlPattern: escapePathForRegex(new URL(trace.endState.url).pathname) },
          ...(options.extraPostconditions ?? []),
        ]
      : options.extraPostconditions ?? [];

  return {
    name: options.name,
    description: options.description,
    goal: trace.goal,
    preconditions,
    steps: dedupAdjacentWaits(trace.steps),
    postconditions,
    requires: options.requires ?? [],
    stats: emptyStats(),
    origin: options.origin ?? "ai-extracted",
    status: "candidate",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Two consecutive `wait` steps with the same `ms` collapse to one —
 * the AI driver sometimes emits paranoia waits when it doesn't trust
 * a state change, and the redundancy isn't useful.
 */
function dedupAdjacentWaits(steps: ReadonlyArray<RecipeStep>): RecipeStep[] {
  const out: RecipeStep[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (last && last.kind === "wait" && step.kind === "wait" && last.ms === step.ms) {
      continue;
    }
    out.push(step);
  }
  return out;
}

/**
 * Anchor a pathname as a regex source. We anchor at the end to avoid
 * `/cart` matching `/cart/checkout`, but DON'T anchor at the start
 * because URLs may include trailing query/fragment captured upstream.
 */
function escapePathForRegex(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${escaped}(?:[/?#]|$)`;
}
