/**
 * Recipe layer demo — no API key required.
 *
 * Flow:
 *   1. Boot a tiny in-process HTTP server (a 2-page demo "shop").
 *   2. Define a hand-written recipe that buys an item.
 *   3. Run `verifyAndPromote` to verify the recipe across 3 fresh
 *      contexts. After 3/3 success it's promoted to `verified`.
 *   4. Re-load the store from disk to prove persistence.
 *   5. Drive the same flow via `recipeDriver` selection — no LLM call.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  emptyRecipeStats,
  preconditionsHold,
  recipeDriver,
  RecipeStore,
  runRecipe,
  verifyAndPromote,
  type ActionRecipe,
} from "chaosbringer";

// -------- demo "shop" --------

const homeHtml = `<!doctype html>
<html><body>
  <h1>Demo Shop</h1>
  <ul>
    <li><a id="tshirt" data-test="tshirt" href="/product/tshirt">T-shirt</a></li>
  </ul>
</body></html>`;

const productHtml = `<!doctype html>
<html><body>
  <h1>T-shirt</h1>
  <button id="buy" data-test="buy">Buy now</button>
  <script>
    document.getElementById("buy").addEventListener("click", () => {
      window.location.href = "/thanks";
    });
  </script>
</body></html>`;

const thanksHtml = `<!doctype html>
<html><body><h1 data-test="thanks">Thanks!</h1></body></html>`;

function startDemo(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const send = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/html" });
        res.end(body);
      };
      if (req.url === "/") send(200, homeHtml);
      else if (req.url === "/product/tshirt") send(200, productHtml);
      else if (req.url === "/thanks") send(200, thanksHtml);
      else send(404, "");
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// -------- main --------

async function main() {
  const demo = await startDemo();
  const storeDir = mkdtempSync(join(tmpdir(), "recipes-demo-"));
  const browser = await chromium.launch({ headless: true });

  try {
    // 1. Define the recipe by hand. Origin marked accordingly.
    const recipe: ActionRecipe = {
      name: "shop/buy-tshirt",
      description: "Buy a T-shirt from the demo shop",
      goal: "completion",
      preconditions: [{ urlPattern: "/$" }],
      steps: [
        { kind: "navigate", url: `${demo.url}/`, expectAfter: { hasSelector: "h1" } },
        {
          kind: "click",
          selector: '[data-test="tshirt"]',
          expectAfter: { urlContains: "/product/tshirt", timeoutMs: 3000 },
        },
        {
          kind: "click",
          selector: '[data-test="buy"]',
          expectAfter: { urlContains: "/thanks", timeoutMs: 3000 },
        },
      ],
      postconditions: [{ hasSelector: '[data-test="thanks"]' }],
      requires: [],
      stats: emptyRecipeStats(),
      origin: "hand-written",
      status: "candidate",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const store = new RecipeStore({
      localDir: storeDir,
      globalDir: false,
      minRuns: 3,
      minSuccessRate: 1,    // strict for demo: 3/3 to promote
      silent: true,
    });
    store.upsert(recipe);
    console.log(`Recipe '${recipe.name}' inserted as ${store.get(recipe.name)!.status}`);

    // 2. Verify it across 3 fresh contexts.
    console.log("\nVerifying...");
    const result = await verifyAndPromote(store, recipe, {
      runs: 3,
      minSuccessRate: 1,
      verbose: true,
      setupPage: async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        return { page, cleanup: () => context.close() };
      },
    });
    console.log(`\nVerification: promoted=${result.promoted}  rate=${result.successRate}`);

    // 3. Re-load the store to prove persistence — a fresh process would
    //    see the same verified recipe.
    const reload = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    const persisted = reload.get(recipe.name)!;
    console.log(`\nAfter reload: status=${persisted.status} successCount=${persisted.stats.successCount}`);

    // 4. Drive the recipe through recipeDriver — exactly what happens
    //    inside a chaos crawl, but here we call selectAction directly.
    console.log("\nDriving via recipeDriver:");
    const driver = recipeDriver({ store: reload, goal: "completion", verbose: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${demo.url}/`);
    // The driver expects a DriverStep — we synthesise the minimal shape.
    const pick = await driver.selectAction({
      url: page.url(),
      page,
      candidates: [],
      history: [],
      stepIndex: 0,
      rng: { next: () => 0 } as never,
      screenshot: async () => Buffer.from(""),
      invariantViolations: [],
    });
    if (pick && pick.kind === "custom") {
      const action = await pick.perform(page);
      console.log(`recipeDriver fired: success=${action.success}  url=${page.url()}`);
    } else {
      console.log("recipeDriver did not select a recipe (precondition mismatch?)");
    }
    await context.close();

    // Sanity: precondition matcher exposed in the public surface.
    void preconditionsHold;
  } finally {
    await browser.close().catch(() => {});
    await demo.close();
    rmSync(storeDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
