import { test, expect, type Page } from "@playwright/test";
import { collectorInitScript, startSession } from "../src/core";

// Multi-document drain. The in-page collector store is recreated on every
// navigation; lightbringer drains it at every span boundary and, for a document
// that unloads mid-span, on pagehide through the __lbEmit CDP binding — so long
// tasks of earlier documents stay in the report.
//
// The busy work runs from the page's own click handler: work injected via
// page.evaluate is invisible to the Long Tasks API.

const ORIGIN = "http://lb-nav.test";
const html = (title: string) => `<!doctype html><meta charset=utf8><title>${title}</title>
<script>
  window.burn = (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) {} };
</script>
<h1>${title}</h1>
<button id=b onclick="window.burn(120)">burn</button>`;

// a host page with a same-origin iframe; #rm burns, then removes the iframe
const HOST = `<!doctype html><meta charset=utf8><title>host</title>
<script>
  window.burn = (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) {} };
</script>
<iframe id=f src="/frame"></iframe>
<button id=rm onclick="window.burn(150); document.getElementById('f').remove()">rm</button>`;

async function servePages(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || "a";
    const body = name === "host" ? HOST : html(name);
    return route.fulfill({ contentType: "text/html", body });
  });
}

test.describe("multi-navigation", () => {
  test("a document-A long task survives navigating to document B", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client);
    const perf = session.controller;

    await page.goto(`${ORIGIN}/a`);
    await perf.measure("burn-in-A", async () => {
      await page.locator("#b").click();
    });
    await perf.measure("goto-B", async () => {
      await page.goto(`${ORIGIN}/b`);
    });

    const { report } = await session.finish("multi-nav");
    const a = report.spans.find((s) => s.name === "burn-in-A")!;
    expect(a.cpu.longTaskCount).toBeGreaterThanOrEqual(1);
    expect(a.cpu.blockingMs).toBeGreaterThan(0);
    expect(a.cpu.maxLongTaskMs).toBeGreaterThanOrEqual(100);
    const b = report.spans.find((s) => s.name === "goto-B")!;
    expect(b.cpu.maxLongTaskMs).toBeLessThan(100);
    expect(report.documents?.map((d) => new URL(d.url).pathname)).toEqual(["/a", "/b"]);
    // top-level vitals stay the last document's (compat)
    expect(report.vitals).toEqual(report.documents![1].vitals);
    expect(report.collectorMissing).toBeUndefined();
  });

  test("a long task is kept when the page navigates away before the span ends (pagehide emit)", async ({
    page,
  }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client);
    const perf = session.controller;

    await page.goto(`${ORIGIN}/a`);
    const h = await perf.begin("burn-then-leave");
    await page.locator("#b").click();
    // No drain in A after the burn: its entries only reach node via pagehide.
    await page.goto(`${ORIGIN}/b`);
    await perf.end(h);

    const { report } = await session.finish("multi-nav-pagehide");
    const s = report.spans.find((x) => x.name === "burn-then-leave")!;
    expect(s.cpu.longTaskCount).toBeGreaterThanOrEqual(1);
    expect(s.cpu.blockingMs).toBeGreaterThan(0);
    expect(s.cpu.maxLongTaskMs).toBeGreaterThanOrEqual(100);
    expect(report.documents).toHaveLength(2);
  });

  test("end() tolerates a page closed mid-span", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client);
    const perf = session.controller;

    await page.goto(`${ORIGIN}/a`);
    const h = await perf.begin("close-mid-span");
    await page.locator("#b").click();
    await page.close();
    await perf.end(h); // must not throw
    await perf.end(h); // second end of the same handle is a no-op

    const { report } = await session.finish("closed");
    expect(report.spans.map((s) => s.name)).toEqual(["close-mid-span"]);
    expect(report.spans[0].durationMs).toBeGreaterThanOrEqual(0);
    // no end snapshot: zero deltas, not "0 - before"
    const raw = perf.spans[0];
    for (const v of Object.values(raw.render)) expect(v).toBeGreaterThanOrEqual(0);
    expect(raw.memory.jsHeapDeltaMB).toBe(0);
    expect(raw.memory.listenersDelta).toBe(0);
    expect(raw.traceEndUs).toBeGreaterThanOrEqual(raw.traceStartUs);
  });

  test("an unloading same-origin iframe does not emit as a top-level document", async ({
    page,
  }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client);
    const perf = session.controller;

    await page.goto(`${ORIGIN}/host`);
    await page.frameLocator("#f").locator("h1").waitFor();
    await perf.measure("burn-and-remove", async () => {
      await page.locator("#rm").click();
    });
    const { report } = await session.finish("iframe");
    const s = report.spans[0];
    expect(s.cpu.longTaskCount).toBe(1);
    expect(s.cpu.maxLongTaskMs).toBeGreaterThanOrEqual(100);
    expect(report.documents).toBeUndefined();
  });

  test("a context-level collector does not report the initial about:blank", async ({
    context,
  }) => {
    await context.addInitScript({ content: collectorInitScript() });
    // a page created after the init script, so its initial about:blank runs it
    const page = await context.newPage();
    await servePages(page);
    const client = await context.newCDPSession(page);
    const session = await startSession(page, client, { installCollector: false });
    const h = await session.controller.begin("first-goto");
    await page.goto(`${ORIGIN}/a`);
    await session.controller.end(h);
    const { report } = await session.finish("about-blank");
    expect(report.documents).toBeUndefined();
    expect(report.collectorMissing).toBeUndefined();
  });

  test("setContent-only runs still report collectorMissing", async ({ page }) => {
    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client);
    await page.setContent("<p>no init scripts here</p>");
    await session.controller.measure("noop", async () => {});
    const { report } = await session.finish("set-content");
    expect(report.collectorMissing).toBe(true);
    expect(report.documents).toBeUndefined();
  });
});
