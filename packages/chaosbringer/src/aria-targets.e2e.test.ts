import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { aiDriver } from "./drivers/ai-driver.js";
import { anthropicDriverProvider } from "./drivers/providers/anthropic.js";
import type { Driver, DriverStep } from "./drivers/types.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * A `<div onclick>` with a pointer cursor is a control to a user and nothing
 * to the CSS scrape, which looks for links, buttons, eight roles and form
 * fields. With `ariaTargets` the accessibility snapshot finds it.
 */
const PAGE = `<!doctype html><title>Shop</title>
<main><h1>Shop</h1>
  <div class="card" style="cursor:pointer" onclick="fetch('/opened')">Open card</div>
  <div role="dialog" aria-label="Checkout"><button onclick="fetch('/paid')">Pay</button></div>
</main>`;

describe("ariaTargets", () => {
  let server: TestServer;
  const hits: string[] = [];

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.url === "/" ? PAGE : "ok");
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  const crawl = (ariaTargets: boolean, driver?: Driver) =>
    new ChaosCrawler({
      baseUrl: `${server.url}/`,
      maxPages: 1,
      maxActionsPerPage: 6,
      headless: true,
      seed: 3,
      actionWeights: { scroll: 0 },
      ariaTargets,
      ...(driver ? { driver } : {}),
    }).start();

  it("acts on a clickable the CSS scrape cannot see", async () => {
    hits.length = 0;
    await crawl(false);
    expect(hits).not.toContain("/opened");

    hits.length = 0;
    const report = await crawl(true);
    expect(hits).toContain("/opened");
    expect(report.actions.some((a) => a.type === "click" && a.selector === 'div:has-text("Open card")' && a.success)).toBe(true);
  }, 60_000);

  it("describes each candidate from the tree, and outlines the page with candidate indices", async () => {
    const steps: { step: DriverStep; outline: string }[] = [];
    const recorder: Driver = {
      name: "recorder",
      async selectAction(step) {
        steps.push({ step, outline: await step.outline!() });
        return null;
      },
    };
    await crawl(true, recorder);
    const { step, outline } = steps[0]!;
    const descriptions = step.candidates.map((c) => c.description);
    expect(descriptions).toContain('button "Pay" — in dialog "Checkout", under "Shop" (button)');
    expect(descriptions).toContain('clickable "Open card" — in main, under "Shop" (interactive)');
    const pay = step.candidates.find((c) => c.description.startsWith('button "Pay"'))!;
    expect(outline).toContain(`[#${pay.index}] button "Pay"`);
    expect(outline).toContain('heading "Shop" [level=1]');
  }, 60_000);

  it("puts the outline in the model's prompt", async () => {
    const prompts: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: { type: string; text?: string }[] }[] };
      prompts.push(body.messages[0]!.content.find((c) => c.type === "text")!.text!);
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"index":0,"reasoning":"r"}' }] }), { status: 200 });
    }) as typeof fetch;
    const provider = anthropicDriverProvider({ apiKey: "test", fetch: fetchImpl });
    await crawl(false, aiDriver({ provider, budget: { maxCalls: 1 } }));
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Page outline:");
    expect(prompts[0]).toMatch(/\[#\d+\] button "Pay"/);
  }, 60_000);
});
