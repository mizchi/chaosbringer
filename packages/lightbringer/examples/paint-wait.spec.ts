import { deflateSync } from "node:zlib";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { awaitPendingPaint, startSession, type SessionOptions } from "../src/core";

// finish() waits, bounded, for a contentful paint the browser has drawn but
// not yet presented, so report.vitals carry it. A real presentation stall needs
// the GPU process stopped (chaosbringer's paint-wait.stall.e2e.test.ts); these
// pin what a stall-free run shows: a paint that never comes costs a few frames
// after every span closed (no span gets longer), `awaitPaint: false` skips the
// wait, and pages with nothing to wait for pay nothing.

const ORIGIN = "http://lb-paint.test";

/** A noise PNG: incompressible, so Chromium's LCP never skips it as low-entropy. */
function noisePng(size: number): Buffer {
  let s = 3;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) & 0xff;
  };
  const row = size * 3 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) for (let x = 1; x < row; x++) raw[y * row + x] = rand();
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let c = 0xffffffff;
    for (const b of td) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const H1 = `<h1 style="margin:0;font:32px system-ui">Sea view resort</h1>`;
const PAGES: Record<string, string> = {
  "/text": `<!doctype html><title>t</title><body>${H1}</body>`,
  "/blank": `<!doctype html><title>t</title><body></body>`,
  "/input": `<!doctype html><title>t</title><body style="margin:0">${H1}<button id="b">ok</button><img src="/hero.png" width="400" height="400"></body>`,
  // Every frame comes late: the page's own rAF loop holds each one ~60 ms.
  "/slow-frames": `<!doctype html><title>t</title><body>${H1}<script>
    (function f() { const t = performance.now(); while (performance.now() - t < 60); requestAnimationFrame(f); })();
  </script></body>`,
};
const HERO = noisePng(400);

/**
 * Hides the paint entries from page script, so FCP reads as never presented.
 * Counts the reads in `__paintReads`: one per in-page check.
 */
const HIDE_PAINT = `(() => {
  const orig = performance.getEntriesByType.bind(performance);
  window.__paintReads = 0;
  performance.getEntriesByType = (t) => (t === "paint" ? (window.__paintReads++, []) : orig(t));
})();`;

async function servePages(page: Page) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/hero.png") {
      // Served 400 ms in: well after the heading painted.
      await new Promise((r) => setTimeout(r, 400));
      return route.fulfill({ contentType: "image/png", body: HERO });
    }
    const body = PAGES[path];
    return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "" });
  });
}

/** One session on a fresh page: a measured load of `path`, then finish(). */
async function loadAndFinish(
  browser: Browser,
  path: string,
  opts: SessionOptions & { initScript?: string; afterLoad?: (page: Page) => Promise<void> } = {},
) {
  const page = await browser.newPage();
  try {
    await servePages(page);
    if (opts.initScript) await page.addInitScript({ content: opts.initScript });
    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client, opts);
    await session.controller.measure("load", async () => {
      await page.goto(`${ORIGIN}${path}`, { waitUntil: opts.afterLoad ? "domcontentloaded" : "load" });
    });
    await opts.afterLoad?.(page);
    const t0 = Date.now();
    const { report } = await session.finish(path);
    return { report, finishMs: Date.now() - t0 };
  } finally {
    await page.close();
  }
}

test.describe("finish() waits for a paint not yet presented", () => {
  test("a pending FCP that never comes costs a few frames, after the spans closed", async ({ browser }) => {
    const clean = await loadAndFinish(browser, "/text");
    expect(clean.report.vitals.FCP?.value).toBeGreaterThan(0);
    expect(clean.report.paintWait).toBeUndefined();

    const forced = await loadAndFinish(browser, "/text", { initScript: HIDE_PAINT });
    expect(forced.report.paintWait).toMatchObject({ outcome: "frames", pending: ["fcp"], stillPending: ["fcp"], content: "text" });
    expect(forced.report.paintWait!.frames).toBeLessThanOrEqual(9);
    expect(forced.report.paintWait!.waitedMs).toBeLessThan(300);
    // The span closed before the wait: its duration does not include it.
    expect(Math.abs(forced.report.spans[0]!.durationMs - clean.report.spans[0]!.durationMs)).toBeLessThan(50);
  });

  test("awaitPaint: false skips the wait", async ({ browser }) => {
    const { report } = await loadAndFinish(browser, "/text", { initScript: HIDE_PAINT, awaitPaint: false });
    expect(report.paintWait).toBeUndefined();
  });

  test("a blank page has nothing to wait for", async ({ browser }) => {
    const { report } = await loadAndFinish(browser, "/blank");
    expect(report.paintWait).toBeUndefined();
  });

  test("an image that loads after a click is not waited for: Chromium reports no LCP after input", async ({ browser }) => {
    const { report } = await loadAndFinish(browser, "/input", {
      afterLoad: async (page) => {
        await page.waitForTimeout(100);
        await page.click("#b");
        await page.waitForLoadState("load");
        await page.waitForTimeout(400);
      },
    });
    expect(report.paintWait).toBeUndefined();
  });

  test("a capped last span is not waited after: the paint then waits on the network", async ({ browser }) => {
    const { report } = await loadAndFinish(browser, "/text", {
      initScript: HIDE_PAINT,
      settle: () => new Promise(() => {}),
      settleTimeoutMs: 200,
    });
    expect(report.spans[0]!.capped).toBe(true);
    expect(report.paintWait).toBeUndefined();
  });
});

// The wait's own bounds, on a page whose frames all come late: no frame
// counts as normal cadence, so only the total-frame cap ends the wait before
// the wall cap, and a wait the wall cap abandoned stops its in-page loop.
test.describe("awaitPendingPaint on slow frames", () => {
  async function slowFramesPage(browser: Browser) {
    const page = await browser.newPage();
    await servePages(page);
    await page.addInitScript({ content: HIDE_PAINT });
    await page.goto(`${ORIGIN}/slow-frames`, { waitUntil: "load" });
    return page;
  }

  test("ends at the total-frame cap, well before the wall cap", async ({ browser }) => {
    const page = await slowFramesPage(browser);
    try {
      const r = await awaitPendingPaint(page);
      expect(r).toMatchObject({ outcome: "frames", initial: ["fcp"], final: ["fcp"] });
      // Fewer than 5 frames came at normal cadence, so the total-frame cap
      // ended it: the baseline frame and 8 more.
      expect(r.flowing).toBeLessThan(5);
      expect(r.frames).toBe(9);
      expect(r.waitedMs).toBeLessThan(900);
    } finally {
      await page.close();
    }
  });

  test("a wait the wall cap abandoned stops checking the page", async ({ browser }) => {
    const page = await slowFramesPage(browser);
    try {
      const r = await awaitPendingPaint(page, { maxMs: 150 });
      expect(r.outcome).toBe("timeout");
      // At most one more frame (~60 ms) runs a check after the deadline.
      await page.waitForTimeout(150);
      const settled = await page.evaluate(() => (window as unknown as { __paintReads: number }).__paintReads);
      // Without the deadline the loop would run on to its 8 frames (~500 ms).
      await page.waitForTimeout(500);
      const later = await page.evaluate(() => (window as unknown as { __paintReads: number }).__paintReads);
      expect(later).toBe(settled);
    } finally {
      await page.close();
    }
  });
});
