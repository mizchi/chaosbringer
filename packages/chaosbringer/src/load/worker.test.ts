import { describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { defineScenario } from "./scenario.js";
import { ScenarioWorker, type WorkerOptions } from "./worker.js";

// Just enough of Playwright for a worker to run: the scenarios below never
// touch the page, and the sampler only subscribes to page events.
function fakeBrowser(): Browser {
  const page = {
    on() {},
    off() {},
    url: () => "about:blank",
    evaluate: async () => ({}),
  };
  const context = { newPage: async () => page, close: async () => {} };
  return { newContext: async () => context } as unknown as Browser;
}

describe("ScenarioWorker", () => {
  it("does not count an iteration the deadline cut short as a finished one", async () => {
    // Stop becomes true once the second iteration's first step has run, so
    // iteration 1 never reaches its second step.
    let firstSteps = 0;
    let stop = false;
    const scenario = defineScenario({
      name: "s",
      steps: [
        {
          name: "a",
          run: async () => {
            firstSteps += 1;
            if (firstSteps === 2) stop = true;
          },
        },
        { name: "b", run: async () => {} },
      ],
    });
    const worker = new ScenarioWorker({
      workerIndex: 0,
      scenario,
      baseUrl: "http://x",
      defaultThinkTime: { distribution: "none" },
      shouldStop: () => stop,
    });
    const samples = await worker.run(fakeBrowser());

    // Every step that ran is still a measured step sample …
    expect(samples.steps.map((s) => `${s.iteration}:${s.stepName}`)).toEqual(["0:a", "0:b", "1:a"]);
    // … but only iteration 0 ran all its steps. Counting iteration 1 as a
    // successful iteration would pair `iterations: 2` with a step `b` seen
    // once, and inflate throughput with work that never happened.
    expect(samples.iterations.map((i) => i.iteration)).toEqual([0]);
    expect(samples.truncatedIterations).toBe(1);
  });

  it("counts an iteration whose last step ran before the deadline as finished", async () => {
    let stop = false;
    const scenario = defineScenario({
      name: "s",
      steps: [
        { name: "a", run: async () => {} },
        {
          name: "b",
          run: async () => {
            stop = true;
          },
        },
      ],
    });
    const worker = new ScenarioWorker({
      workerIndex: 0,
      scenario,
      baseUrl: "http://x",
      defaultThinkTime: { distribution: "none" },
      shouldStop: () => stop,
    });
    const samples = await worker.run(fakeBrowser());
    expect(samples.iterations.map((i) => i.iteration)).toEqual([0]);
    expect(samples.truncatedIterations ?? 0).toBe(0);
  });

  /** Runs a worker with `opts` until `ms` have passed; returns its samples. */
  async function runFor(
    ms: number,
    opts: Partial<WorkerOptions> & Pick<WorkerOptions, "scenario">,
    browser = fakeBrowser(),
  ) {
    const deadline = Date.now() + ms;
    const worker = new ScenarioWorker({
      workerIndex: 0,
      baseUrl: "http://x",
      shouldStop: () => Date.now() >= deadline,
      ...opts,
    });
    return worker.run(browser);
  }

  it("waits after a failed iteration, at least the floor when the think time is none", async () => {
    // A step that throws at once used to loop with no wait at all: a failed
    // step skipped its think time, and 50k iterations a second followed.
    const scenario = defineScenario({
      name: "s",
      steps: [
        {
          name: "a",
          run: async () => {
            throw new Error("down");
          },
        },
      ],
    });
    const samples = await runFor(500, { scenario, defaultThinkTime: { distribution: "none" } });
    expect(samples.iterations.length).toBeGreaterThan(0);
    // 100ms apart: about 5 in 500ms.
    expect(samples.iterations.length).toBeLessThanOrEqual(6);
    expect(samples.iterations.every((i) => !i.success)).toBe(true);
  });

  it("waits the failed step's think time after a failed iteration", async () => {
    const scenario = defineScenario({
      name: "s",
      steps: [
        {
          name: "a",
          thinkTime: { minMs: 300, maxMs: 300, distribution: "uniform" },
          run: async () => {
            throw new Error("down");
          },
        },
      ],
    });
    const samples = await runFor(500, { scenario, defaultThinkTime: { distribution: "none" } });
    // One at t=0, one at t≈300ms, none after.
    expect(samples.iterations.length).toBe(2);
    // The wait comes between iterations, not inside the failed one.
    expect(samples.iterations[0]?.durationMs).toBeLessThan(100);
  });

  it("reports each finished iteration's failure, and a step's stopRun ends the run", async () => {
    const ends: Array<string | null> = [];
    const stops: string[] = [];
    let stopped = false;
    const scenario = defineScenario({
      name: "s",
      steps: [
        {
          name: "a",
          run: async (ctx) => {
            if (ctx.iteration === 1) throw new Error("boom");
            if (ctx.iteration === 2) ctx.stopRun?.("nothing left");
          },
        },
      ],
    });
    const worker = new ScenarioWorker({
      workerIndex: 0,
      scenario,
      baseUrl: "http://x",
      defaultThinkTime: { distribution: "none" },
      shouldStop: () => stopped,
      // Bounds the run should stopRun never reach the runner.
      maxIterations: 10,
      stopRun: (cause, reason) => {
        stops.push(`${cause}: ${reason}`);
        stopped = true;
      },
      onIterationEnd: (failure) => ends.push(failure),
    });
    const samples = await worker.run(fakeBrowser());
    expect(stops).toEqual(["scenario: nothing left"]);
    expect(ends).toEqual([null, "boom", null]);
    expect(samples.iterations.map((i) => i.iteration)).toEqual([0, 1, 2]);
  });

  it("keeps a failing run's network samples, however many", async () => {
    // Only a step that passes drains the sampler, so a run whose steps kept
    // failing hands the worker every request at the end, where a spread into
    // `push` overflowed the call stack and lost the worker's samples.
    const handlers = new Map<string, (arg: unknown) => void>();
    const page = {
      on(event: string, fn: (arg: unknown) => void) {
        handlers.set(event, fn);
      },
      off() {},
      url: () => "about:blank",
      evaluate: async () => ({}),
    };
    const context = { newPage: async () => page, close: async () => {} };
    const browser = { newContext: async () => context } as unknown as Browser;
    const n = 200_000;
    const scenario = defineScenario({
      name: "s",
      steps: [
        {
          name: "a",
          run: async () => {
            for (let i = 0; i < n; i++) {
              const req = { url: () => `http://x/api/${i}` };
              handlers.get("request")?.(req);
              handlers.get("requestfailed")?.(req);
            }
            throw new Error("down");
          },
        },
      ],
    });
    const samples = await runFor(30_000, { scenario, maxIterations: 1 }, browser);
    expect(samples.iterations).toHaveLength(1);
    expect(samples.network).toHaveLength(n);
  });
});
