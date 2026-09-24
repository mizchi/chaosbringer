import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { Driver, DriverPick, DriverStep } from "./drivers/types.js";
import { formatReport } from "./reporter.js";
import type { CrawlerEvents, CrawlerOptions, CrawlReport, PageError } from "./types.js";

/**
 * Per-step measurement, end to end: a load span per page and an action span
 * per chaos action, measured by lightbringer on the page's shared CDP session.
 *
 * A browser is the only honest test. A long task exists only once the main
 * thread really blocks, and "no extra CDP session with perf off" is a
 * statement about what the crawler asked Chromium for.
 */

/**
 * A button whose click handler spins for 120 ms — one long task inside the
 * click's span — and a second button the driver hides right before picking
 * it, so the crawler skips it as not visible.
 */
const PERF = `<!doctype html><title>perf</title><body>
  <h1>Per-step measurement</h1>
  <button id="busy">Busy</button>
  <button id="ghost">Ghost</button>
  <script>
    document.getElementById("busy").addEventListener("click", () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 120) {}
      document.body.dataset.clicked = "1";
    });
  </script>
</body>`;

/**
 * A text field the driver makes readonly right before picking it, so the
 * crawler's fill times out: an input action that fails.
 */
const FORM = `<!doctype html><title>form</title><body>
  <label>Query <input id="field" name="field"></label>
</body>`;

/** A button that starts a fetch nobody answers, so it is in flight later. */
const FETCHING = `<!doctype html><title>fetching</title><body>
  <button id="fire">Fire</button>
  <script>
    document.getElementById("fire").addEventListener("click", () => {
      fetch("/hang").catch(() => {});
    });
  </script>
</body>`;

const QUIET = `<!doctype html><title>quiet</title><body>
  <h1>Nothing to see</h1>
  <button id="noop">Noop</button>
</body>`;

/**
 * Picks the candidate whose description contains each label in turn, then
 * skips. `hide` labels are hidden in the page first, so the crawler's
 * visibility check turns that pick into a skipped action.
 */
function scriptedDriver(labels: string[], hide: Set<string> = new Set()): Driver {
  let i = 0;
  return {
    name: "scripted",
    onPageStart() {
      i = 0;
    },
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      const label = labels[i++];
      if (label === undefined) return { kind: "skip" };
      const c = step.candidates.find((x) => x.description.includes(label));
      if (!c) return { kind: "skip" };
      if (hide.has(label)) {
        await step.page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) el.style.display = "none";
        }, `#${label.toLowerCase()}`);
      }
      return { kind: "select", index: c.index };
    },
  };
}

describe("per-step perf spans (perf option)", () => {
  let server: http.Server;
  let origin: string;
  let outDir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = req.url ?? "";
      if (path === "/hang") return; // never answers: the goto times out
      const body =
        path === "/perf"
          ? PERF
          : path === "/form"
            ? FORM
            : path === "/fetching"
              ? FETCHING
              : path === "/quiet" || path === "/items/42"
                ? QUIET
                : null;
      if (!body) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    outDir = mkdtempSync(join(tmpdir(), "chaosbringer-perf-e2e-"));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(outDir, { recursive: true, force: true });
  });

  function crawl(
    path: string,
    extra: Partial<CrawlerOptions> = {},
    events: CrawlerEvents = {},
  ): Promise<CrawlReport> {
    return new ChaosCrawler(
      {
      baseUrl: `${origin}${path}`,
      maxPages: 1,
      maxActionsPerPage: 2,
      headless: true,
      timeout: 10_000,
      logLevel: "silent",
      seed: 1,
      ...extra,
      },
      events,
    ).start();
  }

  it("measures the busy click's long task, keys the load span, and records no span for a skipped action", async () => {
    const report = await crawl("/perf", {
      perf: { outDir },
      driver: scriptedDriver(["Busy", "Ghost"], new Set(["Ghost"])),
    });
    const page = report.pages[0]!;

    expect(page.perf?.key).toMatch(/ :: load$/);
    expect(page.perf?.key).toBe("/perf :: load");
    expect(page.perf?.name).toBe("load /perf");
    expect(page.perf!.durationMs).toBeGreaterThan(0);
    expect(page.perf!.network.requestCount).toBeGreaterThanOrEqual(1);
    expect(page.perfPage?.network.totalRequests).toBeGreaterThanOrEqual(1);
    expect(page.perfPage?.collectorMissing).toBeUndefined();
    // The load span has frame cadence. The span opens on the document before
    // `goto`, so this holds only because the collector runs its rAF probe on
    // every document of a perf crawl from the first frame.
    expect(page.perf?.frames).toBeDefined();
    expect(page.perf!.frames!.count).toBeGreaterThan(0);

    // Only the busy click was performed; the ghost pick was skipped.
    expect(report.actions).toHaveLength(1);
    const click = report.actions[0]!;
    expect(click.selector).toBeDefined();
    expect(click.perf?.key).toBe(`/perf :: click ${click.selector}`);
    expect(click.perf!.cpu.longTaskCount).toBeGreaterThanOrEqual(1);
    // lightbringer's `blockingMs` is the *total* long-task time, so a 120 ms
    // handler reads as ~120 ms here. Its TBT share — the part over the 50 ms
    // long-task threshold — is the ~70 ms the handler really blocked input.
    const cpu = click.perf!.cpu;
    expect(cpu.maxLongTaskMs).toBeGreaterThanOrEqual(110);
    const overThreshold = cpu.blockingMs - 50 * cpu.longTaskCount;
    expect(overThreshold).toBeGreaterThanOrEqual(70 - 25);
    expect(overThreshold).toBeLessThanOrEqual(70 + 25);

    // The sidecar holds exactly the load span and the busy click: the
    // skipped ghost pick was cancelled, not recorded as an empty span.
    expect(page.perfPage?.reportPath).toMatch(/^[0-9a-f]{8}-000-perf\.json$/);
    const sidecar = JSON.parse(readFileSync(join(outDir, page.perfPage!.reportPath!), "utf8"));
    expect(sidecar.spans.map((s: { key: string }) => s.key)).toEqual([
      "/perf :: load",
      `/perf :: click ${click.selector}`,
    ]);

    // The reporter prints the page line and the slowest action.
    const text = formatReport(report);
    expect(text).toContain("PER-STEP PERFORMANCE");
    expect(text).toMatch(/\/perf {2}load \d+ms {2}blocking \d+ms {2}\d+ req/);
    expect(text).toContain("Slowest actions:");
    expect(text).toContain(`/perf :: click ${click.selector}`);
  });

  it("measures the weighted-random loop's actions, keyed by route pattern", async () => {
    const report = await crawl("/items/42", { perf: true, maxActionsPerPage: 3 });
    const page = report.pages[0]!;
    expect(page.perf?.key).toBe("/items/:id :: load");
    expect(page.perfPage?.reportPath).toBeUndefined();
    expect(report.actions.length).toBeGreaterThan(0);
    for (const a of report.actions) {
      expect(a.perf?.key.startsWith("/items/:id :: ")).toBe(true);
      expect(a.perf?.network.requests.length).toBeLessThanOrEqual(5);
    }
  });

  it("measures replayed actions too", async () => {
    const tracePath = join(outDir, "trace.jsonl");
    await crawl("/perf", { traceOut: tracePath, driver: scriptedDriver(["Busy"]) });
    const report = await crawl("/perf", { traceReplay: tracePath, perf: { actions: true } });
    const busy = report.actions.find((a) => a.selector && a.perf?.key.includes(a.selector));
    expect(busy?.perf?.cpu.longTaskCount).toBeGreaterThanOrEqual(1);
  });

  it("with actions: false, measures the load only", async () => {
    const report = await crawl("/perf", {
      perf: { actions: false },
      driver: scriptedDriver(["Busy"]),
    });
    expect(report.pages[0]?.perf?.key).toBe("/perf :: load");
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).not.toHaveProperty("perf");
  });

  it("still yields a PageResult, with a load span, when the goto times out", async () => {
    const report = await crawl("/hang", { perf: true, timeout: 1_500 });
    expect(report.pages).toHaveLength(1);
    const page = report.pages[0]!;
    expect(page.status).toBe("timeout");
    expect(page.perf?.key).toBe("/hang :: load");
  });

  it("with perf off: no perf fields, and the reporter prints nothing new", async () => {
    const report = await crawl("/perf", { driver: scriptedDriver(["Busy"]) });
    expect(report.pages[0]).not.toHaveProperty("perf");
    expect(report.pages[0]).not.toHaveProperty("perfPage");
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).not.toHaveProperty("perf");
    expect(formatReport(report)).not.toContain("PER-STEP PERFORMANCE");
  });

  it("opens no CDP session with perf off, and exactly one with perf on (testPage path)", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const count = async (perf: CrawlerOptions["perf"]) => {
        const context = await browser.newContext();
        let sessions = 0;
        const original = context.newCDPSession.bind(context);
        context.newCDPSession = (page) => {
          sessions++;
          return original(page);
        };
        const page = await context.newPage();
        const crawler = new ChaosCrawler({
          baseUrl: origin,
          maxActionsPerPage: 0,
          headless: true,
          timeout: 10_000,
          logLevel: "silent",
          perf,
        });
        const result = await crawler.testPage(page, `${origin}/perf`);
        await context.close();
        return { sessions, result };
      };

      const off = await count(undefined);
      expect(off.sessions).toBe(0);
      expect(off.result).not.toHaveProperty("perf");

      const on = await count(true);
      expect(on.sessions).toBe(1);
      expect(on.result.perf?.key).toBe("/perf :: load");
      // The crawler owns no context on this path, so the session installed
      // the collector on the page itself — it did run.
      expect(on.result.perfPage?.collectorMissing).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it("keys a failed fill as the input it was, not as a click", async () => {
    const report = await crawl("/form", {
      perf: true,
      maxActionsPerPage: 1,
      driver: {
        name: "readonly-field",
        async selectAction(step: DriverStep): Promise<DriverPick | null> {
          const c = step.candidates.find((x) => x.type === "input");
          if (!c) return { kind: "skip" };
          // Readonly after the targets were scraped: `fill` then waits for
          // an editable field until its timeout and throws.
          await step.page.evaluate(() => {
            (document.getElementById("field") as HTMLInputElement).readOnly = true;
          });
          return { kind: "select", index: c.index };
        },
      },
    });
    expect(report.actions).toHaveLength(1);
    const fill = report.actions[0]!;
    expect(fill.success).toBe(false);
    expect(fill.type).toBe("input");
    expect(fill.perf?.key).toBe(`/form :: input ${fill.selector}`);
  });

  it("does not abort a loaded page's requests when the page fails after its load", async () => {
    const errors: PageError[] = [];
    const report = await crawl(
      "/fetching",
      { perf: true, maxActionsPerPage: 1, driver: scriptedDriver(["Fire"]) },
      {
        onError: (e) => errors.push(e),
        // A hook that throws after a good load sends the page down the
        // failure path while the click's fetch is still in flight.
        onAction: () => {
          throw new Error("hook failed");
        },
      },
    );
    const page = report.pages[0]!;
    expect(page.status).toBe("error");
    expect(page.perf?.key).toBe("/fetching :: load");
    // Stopping the load would abort that fetch and report it as a network
    // error, which the same crawl with perf off never reports.
    expect(errors.filter((e) => e.message.includes("ERR_ABORTED"))).toEqual([]);
    expect(page.errors.filter((e) => e.message.includes("ERR_ABORTED"))).toEqual([]);
  });

  it("installs the collector on a caller's page even after the crawler ran start()", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: `${origin}/quiet`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      timeout: 10_000,
      logLevel: "silent",
      perf: true,
    });
    await crawler.start();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await crawler.testPage(page, `${origin}/perf`);
      expect(result.perf?.key).toBe("/perf :: load");
      expect(result.perfPage?.collectorMissing).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it("gives each crawler its own sidecar files in a shared outDir (one crawler per fixture test)", async () => {
    const shared = mkdtempSync(join(tmpdir(), "chaosbringer-perf-shared-"));
    const browser = await chromium.launch({ headless: true });
    try {
      const paths: string[] = [];
      for (const path of ["/perf", "/perf?x=1"]) {
        const crawler = new ChaosCrawler({
          baseUrl: origin,
          maxActionsPerPage: 0,
          headless: true,
          timeout: 10_000,
          logLevel: "silent",
          perf: { outDir: shared },
        });
        const page = await browser.newPage();
        const result = await crawler.testPage(page, `${origin}${path}`);
        await page.close();
        paths.push(result.perfPage!.reportPath!);
      }
      expect(paths[0]).not.toBe(paths[1]);
      expect(readdirSync(shared).sort()).toEqual([...paths].sort());
      const second = JSON.parse(readFileSync(join(shared, paths[1]!), "utf8"));
      expect(second.spans[0].key).toBe("/perf :: load");
    } finally {
      await browser.close();
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("writes nothing to disk without outDir", () => {
    // Every test above except the first ran without `outDir`; only the first
    // test's sidecar and the replay trace are in the directory.
    const files = readdirSync(outDir).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^[0-9a-f]{8}-000-perf\.json$/);
    expect(files[1]).toBe("trace.jsonl");
    expect(existsSync("chaosbringer-perf")).toBe(false);
  });
});
