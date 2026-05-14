/**
 * E2E smoke for `runRecipeWithRequires` against the fixture site.
 *
 * Two recipes:
 *   - `nav/about`       — clicks the "About" link from home → /about
 *   - `nav/about-then-form` — requires `nav/about`; from /about, navigates
 *     to /form via a fresh `goto` step
 *
 * Running the dependent should auto-run the prerequisite first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { runRecipeWithRequires } from "../../src/recipes/composition.js";
import { RecipeStore } from "../../src/recipes/store.js";
import type { ActionRecipe } from "../../src/recipes/types.js";
import { emptyStats } from "../../src/recipes/types.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let browser: Browser;
let storeDir: string;

beforeAll(async () => {
  server = await startFixtureServer(0);
  browser = await chromium.launch({ headless: true });
  storeDir = mkdtempSync(join(tmpdir(), "comp-e2e-"));
}, 30000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await server.close();
  rmSync(storeDir, { recursive: true, force: true });
});

function mkRecipe(name: string, steps: ActionRecipe["steps"], requires: string[] = []): ActionRecipe {
  return {
    name,
    description: "",
    preconditions: [],
    steps,
    postconditions: [],
    requires,
    stats: emptyStats(),
    origin: "hand-written",
    status: "verified",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("runRecipeWithRequires against fixture", () => {
  it("runs prerequisites in topological order before the dependent", async () => {
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    store.upsert(
      mkRecipe("nav/about", [
        { kind: "navigate", url: `${server.url}/`, expectAfter: { hasSelector: "h1" } },
        {
          kind: "click",
          selector: 'a[href="/about"]',
          expectAfter: { urlContains: "/about", timeoutMs: 3000 },
        },
      ]),
    );
    store.upsert(
      mkRecipe(
        "nav/about-then-form",
        [
          {
            kind: "navigate",
            url: `${server.url}/form`,
            expectAfter: { urlContains: "/form", timeoutMs: 3000 },
          },
        ],
        ["nav/about"],
      ),
    );

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const events: string[] = [];
      const result = await runRecipeWithRequires({
        page,
        recipe: store.get("nav/about-then-form")!,
        store,
        onProgress: (ev) => {
          if (ev.kind === "complete") events.push(`${ev.recipe}:${ev.result.ok ? "ok" : "fail"}`);
        },
      });
      expect(result.ok).toBe(true);
      expect(result.failedAt).toBeNull();
      expect(result.ranSequence).toEqual(["nav/about", "nav/about-then-form"]);
      expect(events).toEqual(["nav/about:ok", "nav/about-then-form:ok"]);
      expect(page.url()).toContain("/form");
    } finally {
      await context.close();
    }
  }, 60000);

  it("skips dependencies already replayed in this session", async () => {
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    store.upsert(
      mkRecipe("nav/about-2", [
        { kind: "navigate", url: `${server.url}/` },
        {
          kind: "click",
          selector: 'a[href="/about"]',
          expectAfter: { urlContains: "/about", timeoutMs: 3000 },
        },
      ]),
    );
    store.upsert(
      mkRecipe(
        "nav/about-then-form-2",
        [{ kind: "navigate", url: `${server.url}/form` }],
        ["nav/about-2"],
      ),
    );

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const alreadyRan = new Set<string>(["nav/about-2"]);
      const events: string[] = [];
      const result = await runRecipeWithRequires({
        page,
        recipe: store.get("nav/about-then-form-2")!,
        store,
        alreadyRan,
        onProgress: (ev) => {
          if (ev.kind === "skip") events.push(`${ev.recipe}:skip`);
          else if (ev.kind === "complete") events.push(`${ev.recipe}:${ev.result.ok ? "ok" : "fail"}`);
        },
      });
      expect(result.ok).toBe(true);
      expect(events).toEqual(["nav/about-2:skip", "nav/about-then-form-2:ok"]);
    } finally {
      await context.close();
    }
  }, 60000);

  it("stops + reports failedAt when a dependency fails", async () => {
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    store.upsert(
      mkRecipe("nav/about-broken", [
        {
          kind: "click",
          selector: 'a[href="/does-not-exist"]',
          expectAfter: { urlContains: "/never", timeoutMs: 500 },
        },
      ]),
    );
    store.upsert(
      mkRecipe(
        "dependent",
        [{ kind: "navigate", url: `${server.url}/form` }],
        ["nav/about-broken"],
      ),
    );

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}/`);
      const result = await runRecipeWithRequires({
        page,
        recipe: store.get("dependent")!,
        store,
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("nav/about-broken");
      expect(Object.keys(result.results)).toEqual(["nav/about-broken"]);
    } finally {
      await context.close();
    }
  }, 60000);
});
