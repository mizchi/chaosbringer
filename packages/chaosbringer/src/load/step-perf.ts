/**
 * Load worker ⇄ lightbringer glue: each scenario step of a sampled worker is
 * one lightbringer span. The load-runner counterpart of the crawler's
 * `PagePerf`, much smaller because a step has no result object to attach to:
 * the spans come back as flat samples for `perf-stats.ts` to aggregate.
 *
 * Nothing here throws into the load run. A worker whose session cannot open
 * runs unmeasured, and a `finish()` that fails or hangs falls back to what the
 * session gathered so far.
 */
import type { Page } from "playwright";
import { startSession, type PerfSession, type SpanHandle, type SpanReport } from "lightbringer/core";
import { FINISH_TIMEOUT_MS } from "../perf.js";
import { pageCdp } from "../page-cdp.js";
import type { WorkerPerfSample } from "./perf-stats.js";

type SpanOwner = Pick<WorkerPerfSample, "scenarioName" | "stepName" | "timestamp">;

export class StepPerf {
  /** Owner of each recorded span, in `controller.spans` order. */
  private readonly owners: SpanOwner[] = [];

  private constructor(private readonly session: PerfSession) {}

  /**
   * Open a session on `page`. The collector is not installed here: the runner
   * already put it on the worker's context ahead of the runtime-fault script,
   * as the crawler does, so a `clock-skew` fault cannot reach the clock it
   * captures. No CPU or network throttling is passed either — those belong to
   * the run's faults, not to measurement.
   */
  static async open(page: Page): Promise<StepPerf> {
    const client = await pageCdp(page.context(), page).session();
    const session = await startSession(page, client, { installCollector: false });
    return new StepPerf(session);
  }

  begin(stepName: string): Promise<SpanHandle> {
    return this.session.controller.begin(stepName);
  }

  /**
   * Close a step's span. `settle: false`: the step's own `run` decides when it
   * is done, and a settle here would add think time the scenario never asked
   * for, shifting the load the sampled worker generates. The owner is kept
   * only if lightbringer recorded the span, so later spans never shift onto
   * the wrong step.
   */
  async end(handle: SpanHandle, owner: SpanOwner): Promise<void> {
    const before = this.session.controller.spans.length;
    await this.session.controller.end(handle, { settle: false });
    if (this.session.controller.spans.length > before) this.owners.push(owner);
  }

  /**
   * Every recorded span as a sample. `finish()` does the final drain, so an
   * interaction whose paint landed after its span closed is still counted;
   * it is raced against `FINISH_TIMEOUT_MS` like the crawler's, and on a
   * timeout or error each span is rebuilt from what was already gathered
   * (`peekSpan`: node-side, no page call) rather than dropped.
   */
  async finish(timeoutMs = FINISH_TIMEOUT_MS): Promise<WorkerPerfSample[]> {
    let spans: ReadonlyArray<SpanReport | undefined> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const done = await Promise.race([this.session.finish("load worker"), timeout]);
      if (done) spans = done.report.spans;
    } catch {
      // fall through to peekSpan
    } finally {
      clearTimeout(timer);
    }
    if (!spans) spans = this.owners.map((_, i) => this.session.peekSpan(i));

    const out: WorkerPerfSample[] = [];
    this.owners.forEach((owner, i) => {
      const span = spans[i];
      if (!span) return;
      out.push({
        ...owner,
        durationMs: span.durationMs,
        blockingMs: span.cpu.blockingMs,
        ...(span.interaction ? { interactionMs: span.interaction.maxDurationMs } : {}),
      });
    });
    return out;
  }
}
