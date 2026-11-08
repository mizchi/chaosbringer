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
    currentUrl: url,
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

// recipeDriver took no vars: a verified recipe with `{{password}}` typed the
// braces on every crawl that matched it.
describe("recipeDriver vars", () => {
  const templated = (preconditions: ActionRecipe["preconditions"]) =>
    recipe({
      name: "login",
      status: "verified",
      preconditions,
      steps: [{ kind: "fill", selector: "#p", value: "{{password}}" }],
    });

  it("matches preconditions with the vars filled in, and replays the steps with them", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(templated([{ urlPattern: "^https://x/{{tenant}}/" }]));
    const driver = recipeDriver({ store, vars: { tenant: "acme", password: "pw" } });
    expect(await driver.selectAction(fakeStep("https://x/other/login"))).toBeNull();
    const step = fakeStep("https://x/acme/login");
    const pick = await driver.selectAction(step);
    expect(pick?.kind).toBe("custom");
    const fills: string[] = [];
    const page = { ...step.page, fill: async (_s: string, v: string) => void fills.push(v) } as unknown as DriverStep["page"];
    const result = await (pick as { perform: (p: DriverStep["page"]) => Promise<{ success: boolean }> }).perform(page);
    expect(result.success).toBe(true);
    expect(fills).toEqual(["pw"]);
  });

  it("passes the vars down a requires chain, to the dependency's steps", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe({ name: "auth", status: "candidate", steps: [{ kind: "fill", selector: "#p", value: "{{password}}" }] }));
    store.upsert(recipe({ name: "login", status: "verified", requires: ["auth"], steps: [{ kind: "fill", selector: "#q", value: "{{user}}" }] }));
    const step = fakeStep("https://x/acme/login");
    const pick = await recipeDriver({ store, vars: { password: "pw", user: "ada" } }).selectAction(step);
    expect(pick?.kind).toBe("custom");
    const fills: string[] = [];
    const page = { ...step.page, fill: async (_s: string, v: string) => void fills.push(v) } as unknown as DriverStep["page"];
    const result = await (pick as { perform: (p: DriverStep["page"]) => Promise<{ success: boolean }> }).perform(page);
    expect(result.success).toBe(true);
    expect(fills).toEqual(["pw", "ada"]);
    expect(store.get("auth")!.stats.successCount).toBe(1);
  });

  it("skips a recipe whose preconditions use a variable it was not given, and fails one whose steps do", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(templated([{ urlPattern: "^https://x/{{tenant}}/" }]));
    expect(await recipeDriver({ store, vars: { password: "pw" } }).selectAction(fakeStep("https://x/acme/login"))).toBeNull();
    expect(store.get("login")!.stats.failCount).toBe(0);

    store.upsert(templated([]));
    const pick = await recipeDriver({ store }).selectAction(fakeStep("https://x/acme/login"));
    const result = await (pick as { perform: (p: DriverStep["page"]) => Promise<{ success: boolean; error?: string }> }).perform(
      fakeStep("https://x/acme/login").page,
    );
    expect(result).toMatchObject({ success: false, error: 'recipe:login: variable "password" is not defined' });
  });
});
