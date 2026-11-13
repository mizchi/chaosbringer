import { readdirSync, readFileSync } from "node:fs";
import { startSession } from "lightbringer/core";
import type { PerfReport } from "lightbringer/core";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { PageResult } from "./types.js";
import { noisePng } from "./png.test-helpers.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * A presentation stall at the end of the hero image's response, staged for
 * real: the browser's GPU process is stopped (SIGSTOP) for a few hundred ms
 * right after the image is served, then resumed. Chromium creates an image's
 * LCP entry only once the frame that drew it was presented, so the stall
 * holds the entry back while the load settle (two frames and a quiet
 * network) ends a few frames after the GPU process resumes. Read then, LCP
 * was the earlier text candidate in most runs; the wait after the load span
 * must read the hero. The same holds for lightbringer's own finish(), whose
 * wait must run before the drain that copies report.vitals.
 *
 * Only GPU processes this test file's own browser started are stopped (the
 * parent chain of each reaches this process), so a browser of another test
 * file running in parallel is never touched. Linux only: it reads /proc.
 */

const HERO_PX = 600;
const SCRIPT_DELAY_MS = 300;
const CSS_DELAY_MS = 300;
const IMAGE_DELAY_MS = 100;
const HERO_RULE = `.hero { background-image: url(/img/hero.png); }`;

// The hero is a CSS background named by a stylesheet the deferred script
// injects, so its request starts only after two round trips, well after the
// heading's text painted (examples/perf-patterns late-discovered-lcp, slow).
const PAGE = `<!doctype html><html><head><title>Resort</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  .hero { width: ${HERO_PX}px; height: ${HERO_PX}px; background: #ddd no-repeat; }
  h1, p { padding: 0 16px; }
</style>
<script src="/static/app.js" defer></script>
</head><body><div class="hero"></div><h1>Sea view resort</h1><p id="status">loading</p></body></html>`;

const APP_JS = `(function () {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/static/hero.css";
  document.head.appendChild(link);
  document.getElementById("status").textContent = "app ready";
})();`;

function ppidOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) state ppid ...`: comm may hold spaces, so split after it.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
}

function descendsFromThisProcess(pid: number): boolean {
  for (let p = pid, depth = 0; p > 1 && depth < 20; depth++) {
    p = ppidOf(p);
    if (p === process.pid) return true;
  }
  return false;
}

/** The GPU processes of browsers this process launched. */
function ownGpuPids(): number[] {
  const out: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdline.includes("--type=gpu-process")) continue;
    if (descendsFromThisProcess(Number(entry))) out.push(Number(entry));
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Stall {
  pids: number[];
  ms: number;
  stoppedAt?: number;
  resumedAt?: number;
}

describe.skipIf(process.platform !== "linux")("load LCP after a GPU presentation stall", () => {
  const hero = noisePng(HERO_PX, 11);
  let server: TestServer;
  let origin: string;
  // The stall the next crawl stages, armed by the test before it crawls.
  let stall: Stall | null = null;
  // Processes stopped and not yet resumed, so a failing test never leaves a
  // browser frozen for the next one.
  const stopped = new Set<number>();
  const resume = (pids: number[]) => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // Already gone.
      }
      stopped.delete(pid);
    }
  };
  const results: Array<{ name: string; page: PageResult }> = [];

  beforeAll(async () => {
    server = await startTestServer(async (req, res) => {
      const path = req.url ?? "";
      if (path === "/") {
        // The browser is up by the time it asks for the document.
        if (stall) stall.pids = ownGpuPids();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE);
      } else if (path === "/static/app.js") {
        await sleep(SCRIPT_DELAY_MS);
        res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
        res.end(APP_JS);
      } else if (path === "/static/hero.css") {
        await sleep(CSS_DELAY_MS);
        res.writeHead(200, { "content-type": "text/css", "cache-control": "no-store" });
        res.end(HERO_RULE);
      } else if (path === "/img/hero.png") {
        await sleep(IMAGE_DELAY_MS);
        const armed = stall;
        res.on("finish", () => {
          if (!armed || armed.stoppedAt !== undefined || armed.pids.length === 0) return;
          for (const pid of armed.pids) {
            try {
              process.kill(pid, "SIGSTOP");
              stopped.add(pid);
            } catch {
              // Exited between the scan and now.
            }
          }
          armed.stoppedAt = Date.now();
          setTimeout(() => {
            resume(armed.pids);
            armed.resumedAt = Date.now();
          }, armed.ms);
        });
        res.writeHead(200, { "content-type": "image/png", "content-length": hero.length, "cache-control": "no-store" });
        res.end(hero);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
    origin = server.url;
  });

  afterEach(() => {
    resume([...stopped]);
    stall = null;
  });

  afterAll(async () => {
    resume([...stopped]);
    await server?.close();
  });

  const CASES: Array<{ ms: number; perf: boolean; runs: number }> = [
    { ms: 300, perf: true, runs: 3 },
    { ms: 130, perf: true, runs: 3 },
    { ms: 300, perf: false, runs: 2 },
  ];

  for (const { ms, perf, runs } of CASES) {
    for (let run = 1; run <= runs; run++) {
      const name = `${ms} ms stall, perf ${perf ? "on" : "off"}, run ${run}`;
      it(`reads the hero as LCP after a ${name}`, async (ctx) => {
        const armed: Stall = { pids: [], ms };
        stall = armed;
        const report = await new ChaosCrawler({
          baseUrl: `${origin}/`,
          maxPages: 1,
          maxActionsPerPage: 0,
          headless: true,
          timeout: 15_000,
          logLevel: "error",
          settle: "adaptive",
          perf,
        }).start();
        if (armed.pids.length === 0) {
          ctx.skip("no GPU process of this test's own browser was found in /proc, so no presentation stall can be staged");
          return;
        }
        // The stall really happened, on the hero's response, and ended.
        expect(armed.stoppedAt, "the GPU process was stopped").toBeTypeOf("number");
        expect(armed.resumedAt, "the GPU process was resumed").toBeTypeOf("number");
        const page = report.pages[0]!;
        results.push({ name, page });
        const detail = JSON.stringify({ metrics: page.metrics, paintWait: page.paintWait });
        // The heading's text paints at a few tens of ms; the hero is served
        // after ~700 ms, so anything under 500 ms is the text candidate.
        expect(page.metrics?.lcp, detail).toBeGreaterThanOrEqual(500);
        if (perf) {
          expect(page.perfPage?.vitals.LCP?.value, detail).toBeGreaterThanOrEqual(500);
          expect(String(page.perfPage?.vitals.LCP?.attribution?.url), detail).toMatch(/\/img\/hero\.png$/);
        }
        // A first read that already had the hero needs no wait; one that
        // waited saw the hero presented. When the hero's entry landed between
        // the first read and the check (closing the span takes a few ms),
        // nothing was pending any more and the record is there for the merge.
        if (page.paintWait?.outcome === "none") {
          expect(page.paintWait.changed?.lcp?.[1], detail).toBeGreaterThanOrEqual(500);
        } else if (page.paintWait) {
          expect(page.paintWait.outcome, detail).toBe("reported");
        }
      }, 30_000);
    }
  }

  const lbReports: PerfReport[] = [];
  for (let run = 1; run <= 3; run++) {
    it(`lightbringer finish() puts the hero into report.vitals after a 300 ms stall, run ${run}`, async (ctx) => {
      const armed: Stall = { pids: [], ms: 300 };
      stall = armed;
      const browser = await chromium.launch({ headless: true });
      let report: PerfReport;
      try {
        const page = await browser.newPage();
        const client = await page.context().newCDPSession(page);
        // The default awaitPaint, which chaosbringer turns off for its own wait.
        const session = await startSession(page, client);
        await session.controller.measure("load", async () => {
          // The hero is requested only after the load event (its stylesheet
          // is injected by a deferred script): end the span after it, so the
          // span's settle runs into the stall it starts.
          const served = page.waitForResponse((r) => r.url().endsWith("/img/hero.png")).then((r) => r.finished());
          await page.goto(`${origin}/`, { waitUntil: "load" });
          await served;
        });
        report = (await session.finish("stall")).report;
      } finally {
        await browser.close();
      }
      if (armed.pids.length === 0) {
        ctx.skip("no GPU process of this test's own browser was found in /proc, so no presentation stall can be staged");
        return;
      }
      expect(armed.stoppedAt, "the GPU process was stopped").toBeTypeOf("number");
      expect(armed.resumedAt, "the GPU process was resumed").toBeTypeOf("number");
      lbReports.push(report);
      const detail = JSON.stringify({ LCP: report.vitals.LCP, paintWait: report.paintWait });
      expect(report.vitals.LCP?.value, detail).toBeGreaterThanOrEqual(500);
      expect(String(report.vitals.LCP?.attribution?.url), detail).toMatch(/\/img\/hero\.png$/);
      if (report.paintWait) expect(report.paintWait.outcome, detail).toBe("reported");
    }, 30_000);
  }

  it("waited at least once: the stall held the hero back from the first read", (ctx) => {
    if (results.length === 0) {
      ctx.skip("no stall was staged");
      return;
    }
    // Before the wait existed, the first read missed the hero in ~8 of 10
    // runs; all of them missing it here would mean the stall staged nothing.
    expect(results.some((r) => r.page.paintWait?.outcome === "reported")).toBe(true);
  });

  it("lightbringer's finish() waited at least once", (ctx) => {
    if (lbReports.length === 0) {
      ctx.skip("no stall was staged");
      return;
    }
    expect(lbReports.some((r) => r.paintWait?.outcome === "reported")).toBe(true);
  });
});
