/**
 * Unit tests for `recipeDriver` selection logic. The replay path needs
 * a real Page so it is covered by the E2E smoke; here we stub the
 * `page` with the minimum surface `match.ts` touches.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipeDriver } from "./recipe-driver.js";
import { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";
import type { DriverStep } from "../drivers/types.js";

function recipe(overrides: Partial<ActionRecipe>): ActionRecipe {
  return {
    name: overrides.name ?? "x",
    description: "d",
    preconditions: [],
    steps: [{ kind: "wait", ms: 1 }],
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "ai-extracted",
    status: "verified",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fakeStep(url: string): DriverStep {
  // Only `url`, `page.url()`, and the page's selector matchers are
  // touched by the selection path. We give it just enough to look real.
  return {
    url,
    page: {
      url: () => url,
      waitForSelector: async () => {},
      locator: () => ({
        first: () => ({
          isVisible: async () => true,
        }),
      }),
    } as unknown as DriverStep["page"],
    candidates: [],
    history: [],
    stepIndex: 0,
    rng: { next: () => 0.5 } as DriverStep["rng"],
    screenshot: async () => Buffer.from(""),
    invariantViolations: [],
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rd-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("recipeDriver selection", () => {
  it("returns null when the store has no verified recipes", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe({ name: "a", status: "candidate" }));
    const driver = recipeDriver({ store });
    expect(await driver.selectAction(fakeStep("https://x/"))).toBeNull();
  });

  it("returns a custom pick when a verified recipe matches", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe({
      name: "go",
      status: "verified",
      preconditions: [{ urlPattern: "^https://x" }],
    }));
    const driver = recipeDriver({ store });
    const pick = await driver.selectAction(fakeStep("https://x/"));
    expect(pick).not.toBeNull();
    expect(pick!.kind).toBe("custom");
    if (pick!.kind === "custom") {
      expect(pick.reasoning).toMatch(/replay recipe go/);
      expect(pick.source).toBe("recipe");
    }
  });

  it("skips recipes whose preconditions do not match", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe({
      name: "checkout",
      status: "verified",
      preconditions: [{ urlPattern: "^https://x/checkout" }],
    }));
    const driver = recipeDriver({ store });
    expect(await driver.selectAction(fakeStep("https://x/home"))).toBeNull();
  });

  it("prefers higher success rate over insertion order", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const flaky = recipe({
      name: "flaky",
      status: "verified",
      stats: { ...emptyStats(), successCount: 5, failCount: 5 },
    });
    const reliable = recipe({
      name: "reliable",
      status: "verified",
      stats: { ...emptyStats(), successCount: 10, failCount: 0 },
    });
    store.upsert(flaky);
    store.upsert(reliable);
    const driver = recipeDriver({ store });
    const pick = await driver.selectAction(fakeStep("https://x/"));
    if (pick && pick.kind === "custom") {
      expect(pick.reasoning).toMatch(/reliable/);
    } else {
      throw new Error("expected a custom pick");
    }
  });

  it("filters by goal when provided", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe({ name: "shopping", status: "verified", goal: "completion" }));
    store.upsert(recipe({ name: "attack", status: "verified", goal: "bug-hunting" }));
    const driver = recipeDriver({ store, goal: "completion" });
    const pick = await driver.selectAction(fakeStep("https://x/"));
    if (pick && pick.kind === "custom") {
      expect(pick.reasoning).toMatch(/shopping/);
    } else {
      throw new Error("expected a custom pick");
    }
  });
});
