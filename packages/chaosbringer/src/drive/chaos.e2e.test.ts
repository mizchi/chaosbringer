import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";
import { recipeChaos } from "./chaos.js";
import { planDecider } from "./deciders.js";
import { drive } from "./drive.js";

/**
 * A cart whose "Add" handler shows success without looking at the answer,
 * and has no catch: a 500 still says "Added", a network failure escapes.
 */
const SHOP = `<!doctype html><title>Shop</title><main><h1>Shop</h1>
<button onclick="fetch('/api/cart', { method: 'POST' }).then(() => { document.getElementById('msg').textContent = 'Added to cart'; })">Add to cart</button>
<p id="msg"></p></main>`;

describe("recipeChaos", () => {
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if (req.url === "/api/cart") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"count":1}');
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SHOP);
    });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server.close();
  });

  it("replays the journey drive found with its API failing, and says what broke", async () => {
    const until = { text: "Added to cart" };
    const found = await drive({
      url: `${server.url}/`,
      goal: "add the item to the cart",
      decider: planDecider([{ click: 'button "Add to cart"' }]),
      until,
      browser,
    });
    expect(found.status).toBe("reached");

    const result = await recipeChaos({ recipe: found.recipe!, until, browser, hangReleaseMs: 800 });
    expect(result.endpoints.map((e) => e.label)).toEqual([`${server.url}/api/cart`]);
    expect(result.runs.map((r) => [r.fault, r.replay.ok, r.goalHeld, r.fired > 0])).toEqual([
      ["clean", true, true, false],
      ["status", true, true, true],
      ["abort", true, false, true],
      ["hang", true, false, true],
    ]);
    const titles = result.findings.map((f) => `${f.severity} ${f.title}`);
    expect(titles).toContain("medium HTTP 500: the goal still showed as reached");
    expect(titles.filter((t) => t.startsWith("high ")).map((t) => t.split(":")[0])).toEqual(["high network failure", "high no response"]);
    expect(result.findings.find((f) => f.fault === "abort" && f.severity === "high")!.detail[0]).toContain("Failed to fetch");
  }, 120_000);

  it("says so when the journey calls no API", async () => {
    const found = await drive({
      url: `${server.url}/`,
      goal: "look at the shop",
      decider: planDecider([{ click: 'heading "Shop"' }]),
      browser,
      maxSteps: 1,
    });
    // A heading is not a candidate: the plan gives up, so build the recipe by hand.
    expect(found.status).toBe("gave-up");
    const result = await recipeChaos({
      recipe: {
        name: "look",
        description: "",
        preconditions: [],
        steps: [{ kind: "navigate", url: `${server.url}/` }],
        postconditions: [],
        requires: [],
        stats: { successCount: 0, failCount: 0, avgDurationMs: 0, lastSuccessAt: null, lastFailAt: null, maxDurationMs: 0 },
        origin: "hand-written",
        status: "candidate",
        version: 1,
        createdAt: 0,
        updatedAt: 0,
      },
      browser,
    });
    expect(result.skipped).toBe("the journey called none of the app's own API endpoints");
    expect(result.runs).toHaveLength(1);
  }, 60_000);
});
