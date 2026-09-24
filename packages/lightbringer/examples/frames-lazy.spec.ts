import { test, expect } from "@playwright/test";
import { collectorInitScript, startSession, type PerfWindow } from "../src/core";

// The always-on mode: a crawler installs the collector on every page of every
// crawl with `frames: false`, so pages nobody measures pay no per-frame
// callback. begin() must still start the probe, or spans lose frame cadence.

const ORIGIN = "http://lb-frames.test";
const PAGE = `<!doctype html><meta charset=utf8><p>idle</p>`;

test.describe("collectorInitScript({ frames: false })", () => {
  test("no frames are recorded until a span begins; the span still gets frames", async ({
    context,
    page,
  }) => {
    await context.addInitScript({ content: collectorInitScript({ frames: false }) });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: PAGE }),
    );
    await page.goto(`${ORIGIN}/`);
    // Several frames' worth of idle time: a running probe would have pushed some.
    await page.waitForTimeout(200);
    const idle = await page.evaluate(
      () => (window as unknown as PerfWindow).__perf?.frames.length ?? -1,
    );
    expect(idle).toBe(0);

    const client = await context.newCDPSession(page);
    const session = await startSession(page, client, { installCollector: false });
    await session.controller.measure("wait", () => page.waitForTimeout(300));
    const { report } = await session.finish("frames-lazy");
    expect(report.spans[0].frames).toBeDefined();
    expect(report.spans[0].frames!.count).toBeGreaterThan(5);
  });

  test("a cancelled span is not reported", async ({ context, page }) => {
    await context.addInitScript({ content: collectorInitScript({ frames: false }) });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: PAGE }),
    );
    await page.goto(`${ORIGIN}/`);
    const client = await context.newCDPSession(page);
    const session = await startSession(page, client, { installCollector: false });
    const skipped = await session.controller.begin("skipped");
    session.controller.cancel(skipped);
    await session.controller.measure("kept", () => page.waitForTimeout(50));
    const { report } = await session.finish("cancel");
    expect(report.spans.map((s) => s.name)).toEqual(["kept"]);
  });
});
