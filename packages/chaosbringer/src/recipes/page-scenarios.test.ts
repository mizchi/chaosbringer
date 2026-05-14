import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { loadPageScenarios } from "./page-scenarios.js";
import type { PageDeclaredBundle } from "./page-scenarios.js";

function stubPage(bundle: unknown): Page {
  return {
    evaluate: async (_fn: unknown, _key: string) => bundle,
  } as unknown as Page;
}

describe("loadPageScenarios", () => {
  it("returns [] when nothing is declared", async () => {
    expect(await loadPageScenarios(stubPage(null))).toEqual([]);
  });

  it("returns [] when bundle has no scenarios array", async () => {
    expect(await loadPageScenarios(stubPage({ version: 1 }))).toEqual([]);
  });

  it("converts valid scenarios into candidate-status recipes", async () => {
    const bundle: PageDeclaredBundle = {
      version: 1,
      scenarios: [
        {
          name: "shop/buy",
          steps: [{ kind: "click", selector: "[data-test=buy]" }],
        },
      ],
    };
    const got = await loadPageScenarios(stubPage(bundle));
    expect(got.length).toBe(1);
    expect(got[0]!.name).toBe("shop/buy");
    expect(got[0]!.origin).toBe("page-declared");
    expect(got[0]!.status).toBe("candidate");
    expect(got[0]!.steps).toEqual([{ kind: "click", selector: "[data-test=buy]" }]);
  });

  it("trustPublisher=true upgrades harvested scenarios to verified", async () => {
    const bundle: PageDeclaredBundle = {
      scenarios: [
        { name: "x", steps: [{ kind: "click", selector: "a" }] },
      ],
    };
    const got = await loadPageScenarios(stubPage(bundle), { trustPublisher: true });
    expect(got[0]!.status).toBe("verified");
  });

  it("drops scenarios that fail validation (missing name, no steps, malformed step)", async () => {
    const bundle = {
      scenarios: [
        { steps: [{ kind: "click" }] },                       // no name
        { name: "no-steps", steps: [] },                      // no steps
        { name: "bad-step", steps: [{ wrong: "shape" }] },    // step has no kind
        { name: "ok", steps: [{ kind: "click", selector: "a" }] },
      ],
    };
    const got = await loadPageScenarios(stubPage(bundle));
    expect(got.map((r) => r.name)).toEqual(["ok"]);
  });

  it("respects maxScenarios cap", async () => {
    const bundle = {
      scenarios: Array.from({ length: 100 }, (_, i) => ({
        name: `s${i}`,
        steps: [{ kind: "click", selector: "a" }],
      })),
    };
    const got = await loadPageScenarios(stubPage(bundle), { maxScenarios: 7 });
    expect(got.length).toBe(7);
  });

  it("swallows evaluation errors and returns []", async () => {
    const errorPage = {
      evaluate: async () => {
        throw new Error("frame detached");
      },
    } as unknown as Page;
    expect(await loadPageScenarios(errorPage)).toEqual([]);
  });
});
