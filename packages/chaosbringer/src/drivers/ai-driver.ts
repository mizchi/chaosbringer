/**
 * Per-step AI driver. Asks a `DriverProvider` what to do next, every
 * step (subject to budget + timeout). The provider sees the page
 * screenshot, the candidate list, recent action history, and the most
 * recent invariant violations — enough to reason about which interaction
 * is most likely to surface a bug.
 *
 * Soft-failure protocol: provider returns `null`, throws, or times out →
 * the driver returns `null` so the outer composite/fallback can defer
 * to a cheaper driver (e.g. weighted-random). Soft failures still cost
 * budget (the wall clock was spent).
 *
 * `minConfidence` puts a hesitant answer on that same path. Providers
 * already return a confidence with the pick, and a model that is picking
 * badly tends to report a low one while doing it — so the useful move is
 * to read it rather than to ask a better question:
 *
 * ```ts
 * compositeDriver([
 *   aiDriver({ provider, minConfidence: 0.5 }),
 *   weightedRandomDriver(),
 * ]);
 * ```
 */
import { DriverBudget, type DriverBudgetOptions } from "./budget.js";
import type {
  Driver,
  DriverPick,
  DriverProvider,
  DriverProviderInput,
  DriverStep,
  ScreenshotMode,
} from "./types.js";

export interface AiDriverOptions {
  provider: DriverProvider;
  /** Per-call timeout (ms). Default: 8000. */
  timeoutMs?: number;
  /** Default: "viewport". */
  screenshotMode?: ScreenshotMode;
  /** Skip when fewer than N candidates. Default: 2. */
  minCandidatesToConsult?: number;
  /**
   * Least confidence worth acting on, 0..1. A pick the provider reports
   * below this is dropped — the driver returns `null`, so an enclosing
   * `compositeDriver` falls through to the next driver rather than
   * following a guess.
   *
   * Providers that report no confidence are never gated; there is no
   * signal to gate on, and treating silence as zero would disable the
   * driver. Default: 0 (act on every pick).
   */
  minConfidence?: number;
  /** Optional goal string forwarded to the provider. */
  goal?: string;
  /** Cost ceiling — call count / USD. Default: unlimited. */
  budget?: DriverBudget | DriverBudgetOptions;
}

const TIMEOUT_SENTINEL = Symbol("ai-driver-timeout");

function resolveBudget(opt?: DriverBudget | DriverBudgetOptions): DriverBudget {
  if (opt instanceof DriverBudget) return opt;
  return new DriverBudget(opt);
}

export function aiDriver(opts: AiDriverOptions): Driver {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const screenshotMode: ScreenshotMode = opts.screenshotMode ?? "viewport";
  const minCandidates = opts.minCandidatesToConsult ?? 2;
  const minConfidence = opts.minConfidence ?? 0;
  const budget = resolveBudget(opts.budget);
  const provider = opts.provider;

  return {
    name: `ai/${provider.name}`,

    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      if (step.candidates.length < minCandidates) return null;
      if (!budget.canCall(step.url)) return null;

      // Reserve the slot before the network call so a slow provider can't
      // race past the cap with concurrent steps (future-proofing).
      budget.recordCall(step.url);

      let screenshot: Buffer;
      try {
        screenshot = await step.screenshot(screenshotMode);
      } catch {
        return null;
      }

      const input: DriverProviderInput = {
        url: step.url,
        screenshot,
        candidates: step.candidates.map((c) => ({
          index: c.index,
          description: c.description,
        })),
        history: step.history,
        invariantViolations: step.invariantViolations,
        goal: opts.goal,
        stepIndex: step.stepIndex,
      };

      let raw: typeof TIMEOUT_SENTINEL | Awaited<ReturnType<DriverProvider["selectAction"]>>;
      try {
        raw = await Promise.race([
          provider.selectAction(input),
          new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
            setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs),
          ),
        ]);
      } catch {
        return null;
      }

      if (raw === TIMEOUT_SENTINEL || raw === null) return null;
      if (
        !Number.isInteger(raw.index) ||
        raw.index < 0 ||
        raw.index >= step.candidates.length
      ) {
        return null;
      }
      // A model that is unsure usually says so, and a hesitant pick is
      // worth less than the cheap driver behind it. Standing down here
      // costs the call that was already made, not the step.
      if (typeof raw.confidence === "number" && raw.confidence < minConfidence) {
        return null;
      }

      return {
        kind: "select",
        index: raw.index,
        reasoning: raw.reasoning,
        source: provider.name,
        ...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
      };
    },

    onPageStart(url: string) {
      budget.resetPage(url);
    },
  };
}

/** Exposed for tests / callers that want to inspect spend. */
export function aiDriverBudget(driver: Driver): DriverBudget | null {
  return (driver as unknown as { __budget?: DriverBudget }).__budget ?? null;
}
