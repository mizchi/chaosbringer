import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { Driver, DriverPick, DriverStep } from "./drivers/types.js";
import { runPerfCli } from "./perf-cli.js";
import { formatReport } from "./reporter.js";
import type { CrawlerOptions, CrawlReport } from "./types.js";

/**
 * Phase 2's loop, end to end: crawl a page twice with `perf`, emit budgets
 * from those runs, then crawl a slower variant of the same page. The slower
 * click must fail `perf gate` against the emitted budgets, and a
 * `perfBudgets` rule on its key must put a `perf-budget.*` violation into
 * the crawl report itself.
 *
 * `?slow=1` makes the click handler spin 150 ms. The query is not part of
 * the perfKey, so both variants share one `/app :: click …` key — which is the
 * point: the key survives, the cost changed.
 */
const APP = (spinMs: number) => `<!doctype html><title>app</title><body>
  <button id="go">Go</button>
  <script>
    document.getElementById("go").addEventListener("click", () => {
      const t0 = performance.now();
      while (performance.now() - t0 < ${spinMs}) {}
      document.body.dataset.clicked = "1";
    });
  </script>
</body>`;

/** Click "Go" once per page, then stop. */
const clickGo: Driver = {
  name: "click-go",
  async selectAction(step: DriverStep): Promise<DriverPick | null> {
    if (step.stepIndex > 0) return { kind: "skip" };
    const c = step.candidates.find((x) => x.description.includes("Go"));
    return c ? { kind: "select", index: c.index } : { kind: "skip" };
  },
};

describe("perf budgets: emit → gate → perfBudgets", () => {
  let server: http.Server;
  let origin: string;
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/app") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(APP(url.searchParams.get("slow") === "1" ? 150 : 0));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "chaosbringer-perf-budgets-e2e-"));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
  });

  async function crawl(path: string, extra: Partial<CrawlerOptions>, name: string): Promise<[CrawlReport, string]> {
    const report = await new ChaosCrawler({
      baseUrl: `${origin}${path}`,
      maxPages: 1,
      maxActionsPerPage: 1,
      headless: true,
      timeout: 10_000,
      logLevel: "silent",
      seed: 1,
      driver: clickGo,
      ...extra,
    }).start();
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(report));
    return [report, file];
  }

  it("a slower click fails the gate and its perfBudgets rule", async () => {
    const [fast1, run1] = await crawl("/app", { perf: true }, "fast1.json");
    const [, run2] = await crawl("/app", { perf: true }, "fast2.json");
    const key = fast1.actions[0]?.perf?.key;
    expect(key).toMatch(/^\/app :: click /);
    expect(fast1.perf?.totals.spans).toBe(2);

    const budgets = join(dir, "budgets.json");
    await runPerfCli(["emit-budgets", run1, run2, "--out", budgets]);
    expect(process.exitCode).toBe(0);

    const [slow, slowFile] = await crawl(
      "/app?slow=1",
      // perfBudgets alone turns measurement on: no `perf` here.
      { perfBudgets: [{ match: "/app :: click *", budget: { blockingMs: 100 } }] },
      "slow.json",
    );
    const click = slow.actions[0]!;
    expect(click.perf?.key).toBe(key);
    expect(click.perf!.cpu.blockingMs).toBeGreaterThan(100);

    // The rule's breach is an invariant violation on the page, and fails the run.
    const violation = slow.pages[0]!.errors.find((e) => e.invariantName === "perf-budget.blockingMs");
    expect(violation?.type).toBe("invariant-violation");
    expect(violation?.message).toContain(`[perf-budget.blockingMs] ${key}: blockingMs=`);
    expect(violation?.message).toMatch(/> budget 100 \(rule "\/app :: click \*"\)$/);
    expect(slow.summary.invariantViolations).toBeGreaterThanOrEqual(1);
    expect(slow.pages[0]!.hasErrors).toBe(true);
    expect(slow.reproCommand).toContain("--perf");
    expect(formatReport(slow)).toContain("Across the crawl (1 pages, 2 spans)");

    // And the gate against the emitted budgets fails on the same click.
    await runPerfCli(["gate", slowFile, "--budgets", budgets]);
    expect(process.exitCode).toBe(1);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain(`✗ ${key}  blockingMs median=`);
  }, 60_000);
});
