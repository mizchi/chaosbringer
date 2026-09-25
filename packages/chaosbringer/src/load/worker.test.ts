import { describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { defineScenario } from "./scenario.js";
import { ScenarioWorker } from "./worker.js";

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
});
