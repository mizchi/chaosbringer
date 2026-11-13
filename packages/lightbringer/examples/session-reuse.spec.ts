import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { EMIT_BINDING, startSession } from "../src/core";

// A page that outlives its session (a CDP-attached browser, a fixture page
// measured more than once): finish() takes down what startSession put up, so
// the page stops pushing records into a binding nobody reads, and the next
// session on the same page picks up where the last one left off.

const ORIGIN = "http://lb-reuse.test";
const html = (title: string) => `<!doctype html><meta charset=utf8><title>${title}</title>
<script>
  window.burn = (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) {} };
  window.work = (name) => {
    const t0 = performance.now();
    window.burn(120);
    performance.measure(name, { start: t0, detail: { __lbSpan: true } });
  };
</script>
<h1>${title}</h1>
<button id=b onclick="window.work('between')">work</button>`;

async function servePages(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || "a";
    return route.fulfill({ contentType: "text/html", body: html(name) });
  });
}

function countEmits(client: CDPSession): { calls: number } {
  const seen = { calls: 0 };
  client.on("Runtime.bindingCalled", (e) => {
    if (e.name === EMIT_BINDING) seen.calls++;
  });
  return seen;
}

async function storeCounts(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __perf?: Record<string, unknown[]> }).__perf;
    return { longTasks: s?.longTasks?.length ?? -1, measures: s?.measures?.length ?? -1 };
  });
}

async function oneSpan(page: Page, client: CDPSession, title: string) {
  const session = await startSession(page, client, { awaitPaint: false });
  await session.controller.measure("span", async () => {});
  return (await session.finish(title)).report;
}

test.describe("session reuse on one page", () => {
  test("records made between two sessions reach the second, not a dead binding", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const emits = countEmits(client);
    const s1 = await startSession(page, client, { awaitPaint: false });
    await page.goto(`${ORIGIN}/a`);
    await s1.controller.measure("first", async () => {});
    await s1.finish("s1");

    const before = emits.calls;
    await page.locator("#b").click();
    await page.waitForTimeout(300);
    // Nothing went out, and the store still holds the work.
    expect(emits.calls).toBe(before);
    expect(await storeCounts(page)).toEqual({ longTasks: 1, measures: 1 });

    const report = await oneSpan(page, client, "s2");
    expect(report.appSpans.map((s) => s.name)).toContain("between");
  });

  test("the next session re-attaches the document: a navigation inside its span loses nothing", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const s1 = await startSession(page, client, { awaitPaint: false });
    await page.goto(`${ORIGIN}/a`);
    await s1.controller.measure("first", async () => {});
    await s1.finish("s1");

    // s1 detached /a's collector. Its work in s2's span is pushed on record
    // or on /a's pagehide, never by a drain (begin()'s ran before it), so it
    // reaches s2 only if s2 attached the document again.
    const s2 = await startSession(page, client, { awaitPaint: false });
    await s2.controller.measure("nav", async () => {
      await page.locator("#b").click();
      await page.goto(`${ORIGIN}/b`);
    });
    const { report } = await s2.finish("s2");
    expect(report.spans[0].cpu.longTaskCount).toBe(1);
    expect(report.appSpans.map((s) => s.name)).toContain("between");
  });

  test("finish removes the binding: a later document has none and nothing is reported", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const emits = countEmits(client);
    const s1 = await startSession(page, client, { awaitPaint: false });
    await page.goto(`${ORIGIN}/a`);
    await s1.controller.measure("first", async () => {});
    await s1.finish("s1");
    const before = emits.calls;
    await page.goto(`${ORIGIN}/b`);
    await page.locator("#b").click();
    await page.waitForTimeout(300);
    expect(await page.evaluate((n) => typeof (window as unknown as Record<string, unknown>)[n], EMIT_BINDING)).toBe(
      "undefined",
    );
    expect(emits.calls).toBe(before);
    // The page-level init script went with the session: a new document has no collector.
    expect(await page.evaluate(() => typeof (window as unknown as { __perf?: unknown }).__perf)).toBe("undefined");

    // A new session on the same page measures again, binding and all.
    const s2 = await startSession(page, client, { awaitPaint: false });
    await page.goto(`${ORIGIN}/c`);
    await s2.controller.measure("burn", async () => {
      await page.locator("#b").click();
    });
    expect(emits.calls).toBeGreaterThan(before);
    const { report } = await s2.finish("s2");
    expect(report.spans.find((s) => s.name === "burn")!.cpu.longTaskCount).toBe(1);
  });

  test("the collector is injected once per document however many sessions ran", async ({ page }) => {
    await page.context().addInitScript(() => {
      let v: unknown;
      const w = window as unknown as Record<string, unknown>;
      w.__wvSets = 0;
      Object.defineProperty(window, "webVitals", {
        configurable: true,
        get: () => v,
        set: (x) => {
          (w.__wvSets as number)++;
          v = x;
        },
      });
    });
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    for (const path of ["/a", "/b", "/c"]) {
      const s = await startSession(page, client, { awaitPaint: false });
      await page.goto(`${ORIGIN}${path}`);
      expect(await page.evaluate(() => (window as unknown as { __wvSets: number }).__wvSets)).toBe(1);
      await s.finish(path);
    }
  });

  test("a concurrent session on the same client keeps the binding when another finishes", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const emits = countEmits(client);
    const a = await startSession(page, client, { awaitPaint: false });
    const b = await startSession(page, client, { awaitPaint: false, installCollector: false });
    await page.goto(`${ORIGIN}/a`);
    await a.finish("a");
    const before = emits.calls;
    await b.controller.measure("burn", async () => {
      await page.locator("#b").click();
    });
    expect(emits.calls).toBeGreaterThan(before);
    const { report } = await b.finish("b");
    expect(report.spans[0].cpu.longTaskCount).toBe(1);
    // b was the last: now the page is quiet.
    const after = emits.calls;
    await page.locator("#b").click();
    await page.waitForTimeout(300);
    expect(emits.calls).toBe(after);
  });

  test("a concurrent session keeps the page's collector when the one that installed it finishes", async ({
    page,
  }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const a = await startSession(page, client, { awaitPaint: false });
    const b = await startSession(page, client, { awaitPaint: false, installCollector: false });
    await page.goto(`${ORIGIN}/a`);
    await a.finish("a");
    await page.goto(`${ORIGIN}/b`);
    expect(await page.evaluate(() => typeof (window as unknown as { __perf?: unknown }).__perf)).toBe("object");
    await b.controller.measure("burn", async () => {
      await page.locator("#b").click();
    });
    const { report } = await b.finish("b");
    expect(report.collectorMissing).toBeUndefined();
    expect(report.spans[0].cpu.longTaskCount).toBe(1);
    // b was the page's last session: its next document has no collector.
    await page.goto(`${ORIGIN}/c`);
    expect(await page.evaluate(() => typeof (window as unknown as { __perf?: unknown }).__perf)).toBe("undefined");
  });

  test("a session on another CDP session of the page keeps the document reporting", async ({ page }) => {
    await servePages(page);
    const c1 = await page.context().newCDPSession(page);
    const c2 = await page.context().newCDPSession(page);
    const emits = countEmits(c2);
    const a = await startSession(page, c1, { awaitPaint: false });
    const b = await startSession(page, c2, { awaitPaint: false });
    await page.goto(`${ORIGIN}/a`);
    await a.finish("a");
    const before = emits.calls;
    await page.locator("#b").click();
    await page.waitForTimeout(300);
    // c1 lost its binding, but the document is not detached: b still reads it.
    expect(emits.calls).toBeGreaterThan(before);
    await b.finish("b");
  });

  test("a session that failed to start leaves nothing installed", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const send = client.send.bind(client);
    // Fail a command startSession sends after the binding and the init script.
    (client as { send: unknown }).send = (method: string, params?: object) =>
      method === "Performance.enable"
        ? Promise.reject(new Error("Performance.enable refused"))
        : send(method as Parameters<typeof send>[0], params as Parameters<typeof send>[1]);
    await expect(startSession(page, client, { awaitPaint: false })).rejects.toThrow("Performance.enable refused");
    (client as { send: unknown }).send = send;

    await page.goto(`${ORIGIN}/a`);
    expect(await page.evaluate((n) => typeof (window as unknown as Record<string, unknown>)[n], EMIT_BINDING)).toBe(
      "undefined",
    );
    expect(await page.evaluate(() => typeof (window as unknown as { __perf?: unknown }).__perf)).toBe("undefined");

    // The next session measures, and its finish takes down what it put up,
    // as if the failed one had never run.
    const s2 = await startSession(page, client, { awaitPaint: false });
    await page.goto(`${ORIGIN}/b`);
    await s2.controller.measure("burn", async () => {
      await page.locator("#b").click();
    });
    const { report } = await s2.finish("s2");
    expect(report.spans[0].cpu.longTaskCount).toBe(1);
    await page.goto(`${ORIGIN}/c`);
    expect(await page.evaluate((n) => typeof (window as unknown as Record<string, unknown>)[n], EMIT_BINDING)).toBe(
      "undefined",
    );
    expect(await page.evaluate(() => typeof (window as unknown as { __perf?: unknown }).__perf)).toBe("undefined");
  });

  test("excludeCurrentDocument leaves the document loaded at start out of the report", async ({ page }) => {
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const s1 = await startSession(page, client, { awaitPaint: false });
    await page.goto(`${ORIGIN}/a`);
    await s1.controller.measure("load-a", async () => {});
    await s1.finish("s1");

    const open = async (exclude: boolean, path: string) => {
      const s = await startSession(page, client, { awaitPaint: false, excludeCurrentDocument: exclude });
      const h = await s.controller.begin("load");
      await page.goto(`${ORIGIN}${path}`);
      await s.controller.end(h);
      return (await s.finish(path)).report;
    };
    // Control: adopting the current document reports both.
    const adopted = await open(false, "/b");
    expect(adopted.documents?.map((d) => new URL(d.url).pathname)).toEqual(["/a", "/b"]);
    const excluded = await open(true, "/c");
    expect(excluded.documents).toBeUndefined();
    expect(new URL(excluded.url).pathname).toBe("/c");
    expect(excluded.vitals.TTFB).toBeDefined();
  });
});
