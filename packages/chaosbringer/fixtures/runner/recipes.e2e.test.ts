/**
 * E2E smoke for the recipe layer. Boots a Chromium + the fixture site
 * and exercises three flows end-to-end:
 *   1. `runRecipe` on a hand-written recipe (replay path)
 *   2. `verifyAndPromote` runs K times and promotes a stable recipe
 *   3. A broken recipe fails predictably and is recorded as such
 *
 * The fixture site has a `/form` page with a real form; we use that as
 * the target.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "../site/server.js";
import {
  RecipeStore,
  runRecipe,
  verifyAndPromote,
  type ActionRecipe,
} from "../../src/recipes/index.js";
import { emptyStats } from "../../src/recipes/types.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let browser: Browser;
let storeDir: string;

beforeAll(async () => {
  server = await startFixtureServer(0);
  browser = await chromium.launch({ headless: true });
  storeDir = mkdtempSync(join(tmpdir(), "recipes-e2e-"));
}, 30000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await server.close();
  rmSync(storeDir, { recursive: true, force: true });
});

function buildHomeRecipe(name: string, overrides: Partial<ActionRecipe> = {}): ActionRecipe {
  return {
    name,
    description: "navigate from home to about",
    preconditions: [{ urlPattern: "/$" }],
    steps: [
      { kind: "navigate", url: `${server.url}/`, expectAfter: { hasSelector: "h1" } },
      {
        kind: "click",
        selector: 'a[href="/about"]',
        expectAfter: { urlContains: "/about", timeoutMs: 3000 },
      },
    ],
    postconditions: [{ urlPattern: "/about" }],
    requires: [],
    stats: emptyStats(),
    origin: "hand-written",
    status: "candidate",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function freshPage(): Promise<{ page: Page; cleanup: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page,
    cleanup: async () => {
      await context.close();
    },
  };
}

describe("recipes E2E", () => {
  it("runRecipe drives a hand-written recipe through the fixture site", async () => {
    const { page, cleanup } = await freshPage();
    try {
      await page.goto(server.url);
      const result = await runRecipe(page, buildHomeRecipe("smoke"));
      expect(result.ok).toBe(true);
      expect(page.url()).toContain("/about");
    } finally {
      await cleanup();
    }
  }, 30000);

  it("a broken recipe fails predictably with failedAt populated", async () => {
    const { page, cleanup } = await freshPage();
    try {
      const broken: ActionRecipe = buildHomeRecipe("broken", {
        steps: [
          { kind: "navigate", url: `${server.url}/` },
          {
            kind: "click",
            selector: 'a[href="/no-such-link"]',
            expectAfter: { urlContains: "/never", timeoutMs: 500 },
          },
        ],
      });
      await page.goto(server.url);
      const result = await runRecipe(page, broken);
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBeDefined();
      expect(result.failedAt!.index).toBe(1);
    } finally {
      await cleanup();
    }
  }, 30000);

  it("verifyAndPromote promotes a reliable recipe after K runs", async () => {
    const store = new RecipeStore({
      localDir: storeDir,
      globalDir: false,
      silent: true,
      minRuns: 5,
      minSuccessRate: 0.8,
    });
    const reliable = buildHomeRecipe("home-to-about");
    store.upsert(reliable);

    const result = await verifyAndPromote(store, reliable, {
      runs: 5,
      setupPage: async () => {
        const { page, cleanup } = await freshPage();
        // The recipe starts with a navigate, so no setup goto needed.
        return { page, cleanup };
      },
    });

    expect(result.promoted).toBe(true);
    expect(result.successRate).toBeGreaterThanOrEqual(0.8);
    expect(store.get("home-to-about")!.status).toBe("verified");
    expect(store.get("home-to-about")!.stats.successCount).toBeGreaterThanOrEqual(4);
  }, 90000);
});
