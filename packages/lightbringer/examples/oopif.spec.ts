import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { startSession, type SessionOptions, type SpanReport } from "../src/core";

// Out-of-process iframes (OOPIFs). The page is served from 127.0.0.1 and embeds
// an iframe from `localhost` — another site. In default headless Chromium that
// iframe runs in the page's process and the page's CDP session sees its
// requests; under `--site-per-process` (as in headed Chromium or a real Chrome)
// it is its own target, and lightbringer has to attach to it to see them.
// Both modes must read the same network numbers.

const KB = 1024;
// a comment is valid JS and CSS, and is fetched in full (fake image bytes are not)
const blob = (kb: number) => Buffer.from(`/*${"a".repeat(kb * KB - 4)}*/`);
// a script, a stylesheet and a fetch: 300 KB of subresources in the iframe
const SUB = { "/embed/app.js": 120, "/embed/style.css": 100, "/embed/data.json": 80 };
const EMBED_KB = Object.values(SUB).reduce((a, b) => a + b, 0);

let server: http.Server;
let nestedServer: http.Server;
let port = 0;
let nestedPort = 0;
const top = () => `http://127.0.0.1:${port}`;
const embed = () => `http://localhost:${port}`;
// a third site (127.0.0.2 is loopback too), with its own listener
const nestedOrigin = () => `http://127.0.0.2:${nestedPort}`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const htmlOut = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><meta charset=utf-8>${body}`);
    };
    if (path === "/") return htmlOut(`<h1>top</h1><iframe id=f src="${embed()}/embed"></iframe>`);
    if (path === "/nested")
      return htmlOut(`<h1>top</h1><iframe id=f src="${embed()}/embed?nest=1"></iframe>`);
    if (path === "/embed") {
      const nest = (req.url ?? "").includes("nest=1")
        ? `<iframe src="${nestedOrigin()}/inner"></iframe>`
        : "";
      return htmlOut(
        `<link rel=stylesheet href="/embed/style.css"><script src="/embed/app.js"></script>` +
          `<script>fetch("/embed/data.json").then(r => r.text()).then(() => document.title = "ready")</script>${nest}` +
          `<script>addEventListener("message", (e) => { if (e.data === "next") location.href = "/embed/next"; if (e.data === "away") location.href = "${nestedOrigin()}/inner"; })</script>`,
      );
    }
    if (path === "/embed/next") return htmlOut(`<script src="/embed/next.js"></script><p>next</p>`);
    if (path === "/inner") return htmlOut(`<script src="/inner/deep.js"></script>`);
    if (path === "/embed/slow") return; // never answers
    const kb = (SUB as Record<string, number>)[path] ?? (path === "/embed/next.js" ? 50 : path === "/inner/deep.js" ? 40 : 0);
    if (!kb) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = blob(kb);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length, "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  nestedServer = http.createServer(server.listeners("request")[0] as http.RequestListener);
  await new Promise<void>((r) => nestedServer.listen(0, "127.0.0.2", () => r()));
  nestedPort = (nestedServer.address() as AddressInfo).port;
});

test.afterAll(async () => {
  for (const s of [server, nestedServer]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const MODES = [
  { name: "in-process (default headless)", args: [] as string[], oopif: false },
  { name: "out-of-process (--site-per-process)", args: ["--site-per-process"], oopif: true },
];

async function isOutOfProcess(page: Page): Promise<boolean> {
  const frame = page.frames().find((f) => f !== page.mainFrame())!;
  // Playwright attaches a session to a frame only when it is its own target.
  return page
    .context()
    .newCDPSession(frame)
    .then(async (s) => {
      await s.detach();
      return true;
    })
    .catch(() => false);
}

async function measureLoad(browser: Browser, path: string, opts: SessionOptions = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  const session = await startSession(page, client, opts);
  await session.controller.measure(
    "load",
    async () => {
      await page.goto(`${top()}${path}`);
      await expect.poll(() => page.frames()[1]?.title()).toBe("ready");
    },
    { settle: idle },
  );
  return { context, page, session };
}

const idle = (p: Page) => p.waitForLoadState("networkidle");
const thirdPartyKB = (s: SpanReport) => s.network.thirdParty.encodedKB;

for (const mode of MODES) {
  test.describe(`OOPIF network: ${mode.name}`, () => {
    let browser: Browser;
    test.beforeAll(async () => {
      browser = await chromium.launch({ args: mode.args });
    });
    test.afterAll(async () => {
      await browser.close();
    });

    test("counts the iframe's subresources in the span that loaded it", async () => {
      const { context, page, session } = await measureLoad(browser, "/");
      expect(await isOutOfProcess(page)).toBe(mode.oopif);
      // Playwright still drives the iframe
      expect(await page.frames()[1]!.evaluate(() => location.host)).toBe(`localhost:${port}`);
      const { report } = await session.finish("oopif");
      await context.close();

      const load = report.spans.find((s) => s.name === "load")!;
      // top document + iframe document + 3 subresources
      expect(load.network.requestCount).toBe(5);
      expect(load.network.encodedKB).toBeGreaterThanOrEqual(EMBED_KB);
      expect(load.network.thirdParty.requestCount).toBe(4);
      expect(thirdPartyKB(load)).toBeGreaterThanOrEqual(EMBED_KB);
      expect(thirdPartyKB(load)).toBeLessThan(EMBED_KB + 5);
      expect(load.network.thirdParty.byDomain.map((d) => d.domain)).toEqual(["localhost"]);
      expect(load.network.settledUnfinished).toBeUndefined();
      // the iframe's document has its bytes (they arrive on the iframe's target)
      const doc = load.network.requests.find((r) => r.url === `${embed()}/embed`)!;
      expect(doc.unfinished).toBeUndefined();
      expect(doc.kb).toBeGreaterThan(0);
      expect(report.network.totalRequests).toBe(5);
      expect(report.network.thirdParty.encodedKB).toBeGreaterThanOrEqual(EMBED_KB);
    });

    test("attributes the iframe's later navigation to the span that caused it, and survives removal", async () => {
      const { context, page, session } = await measureLoad(browser, "/");
      const perf = session.controller;
      await perf.measure(
        "iframe-navigates",
        async () => {
          await page.evaluate(() => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage("next", "*"));
          await expect(page.frameLocator("#f").locator("p")).toHaveText("next");
        },
        { settle: idle },
      );
      await perf.measure("iframe-hangs-then-removed", async () => {
        await page.frames()[1]!.evaluate(() => void fetch("/embed/slow").catch(() => {}));
        await page.waitForTimeout(100);
        await page.evaluate(() => document.getElementById("f")!.remove());
      });
      // the page keeps working with new iframes after one went away
      await perf.measure(
        "iframe-again",
        async () => {
          await page.evaluate((src) => {
            const f = document.createElement("iframe");
            f.id = "f";
            f.src = src;
            document.body.append(f);
          }, `${embed()}/embed`);
          await expect.poll(() => page.frames()[1]?.title()).toBe("ready");
        },
        { settle: idle },
      );
      const { report } = await session.finish("oopif-nav");
      await context.close();

      const [load, nav, removed, again] = report.spans;
      expect(load!.network.requestCount).toBe(5);
      // the navigation (document + one image) belongs to the second span only
      expect(nav!.network.requestCount).toBe(2);
      expect(nav!.network.thirdParty.encodedKB).toBeGreaterThanOrEqual(50);
      expect(nav!.network.thirdParty.encodedKB).toBeLessThan(55);
      // the hanging fetch is this span's, and never finished
      expect(removed!.network.requests.map((r) => new URL(r.url).pathname)).toEqual(["/embed/slow"]);
      expect(removed!.network.requests[0]!.kb).toBe(0);
      expect(again!.network.requestCount).toBe(4);
      expect(again!.network.thirdParty.encodedKB).toBeGreaterThanOrEqual(EMBED_KB);
    });

    test("follows an iframe that navigates to another site (a new target)", async () => {
      const { context, page, session } = await measureLoad(browser, "/");
      await session.controller.measure(
        "iframe-leaves",
        async () => {
          await page.evaluate(() => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage("away", "*"));
          await expect
            .poll(() => page.frames()[1]?.evaluate(() => document.scripts.length).catch(() => -1))
            .toBe(1);
        },
        { settle: idle },
      );
      const { report } = await session.finish("oopif-away");
      await context.close();
      const leaves = report.spans[1]!;
      // the new document (sent from the old target, received on the new one) + its script
      expect(leaves.network.requestCount).toBe(2);
      expect(leaves.network.requests.every((r) => !r.unfinished)).toBe(true);
      expect(leaves.network.thirdParty.byDomain.map((d) => d.domain)).toEqual(["127.0.0.2"]);
      expect(leaves.network.thirdParty.encodedKB).toBeGreaterThanOrEqual(40);
    });

    test("counts a nested cross-site iframe", async () => {
      const { context, session } = await measureLoad(browser, "/nested");
      const { report } = await session.finish("oopif-nested");
      await context.close();
      const load = report.spans[0]!;
      // + nested document + its script
      expect(load.network.requestCount).toBe(7);
      const byDomain = Object.fromEntries(load.network.thirdParty.byDomain.map((d) => [d.domain, d]));
      expect(byDomain.localhost!.encodedKB).toBeGreaterThanOrEqual(EMBED_KB);
      expect(byDomain["127.0.0.2"]!.encodedKB).toBeGreaterThanOrEqual(40);
    });
  });
}

test.describe("OOPIF network under --site-per-process", () => {
  let browser: Browser;
  test.beforeAll(async () => {
    browser = await chromium.launch({ args: ["--site-per-process"] });
  });
  test.afterAll(async () => {
    await browser.close();
  });

  test("oopif: false reads only the iframe's document request (the gap it closes)", async () => {
    const { context, session } = await measureLoad(browser, "/", { oopif: false });
    const { report } = await session.finish("oopif-off");
    await context.close();
    const load = report.spans[0]!;
    expect(load.network.requestCount).toBe(2);
    expect(thirdPartyKB(load)).toBe(0);
  });

  test("applies the session's network throttling to the iframe's target", async () => {
    // 300 KB at 200 KB/s: at least ~1.5 s when throttled; unthrottled, a few ms.
    const { context, session } = await measureLoad(browser, "/", {
      netProfile: { latency: 0, downloadThroughput: 200 * KB, uploadThroughput: 200 * KB },
    });
    const { report } = await session.finish("oopif-throttled");
    await context.close();
    const load = report.spans[0]!;
    const app = load.network.requests.find((r) => r.url.endsWith("/embed/app.js"))!;
    expect(app.durationMs).toBeGreaterThan(300);
  });

  test("leaves the page usable after finish (no target held paused)", async () => {
    const { context, page, session } = await measureLoad(browser, "/");
    await session.finish("oopif-after");
    // a new OOPIF after the session stopped attaching must still load
    await page.goto(`${top()}/nested`);
    await expect.poll(() => page.frames().length).toBe(3);
    await expect.poll(() => page.frames()[1]?.title()).toBe("ready");
    await expect
      .poll(() => page.frames()[2]?.evaluate(() => document.scripts.length).catch(() => -1))
      .toBe(1);
    await context.close();
  });
});
