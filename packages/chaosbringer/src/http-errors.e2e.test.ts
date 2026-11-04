import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chaos } from "./chaos.js";
import { ChaosCrawler } from "./crawler.js";
import { faults } from "./faults.js";
import { buildGithubAnnotations } from "./github.js";
import { exitReasons, formatCompactReport, formatQuietReport } from "./reporter.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { CrawlerOptions, CrawlReport, FaultRule, PageError } from "./types.js";

/**
 * A 4xx / 5xx answer to an image or a fetch was recorded only as Chromium's
 * console line "Failed to load resource: the server responded with a status
 * of 500": typed `console`, no method, the status folded into the cluster
 * key, and a run without `--strict` passed. And a strict test of a
 * `faults.status` rule failed on that same line, the fault's own echo, unless
 * it hand-wrote an ignore pattern per status code.
 */
let server: TestServer;

/** A page whose script runs `body`, then marks itself done. */
const page = (body: string, extra = "") =>
  `<!doctype html><title>t</title>${extra}<script>(async () => { ${body} })().finally(() => { window.__cb_done = 1; });</script>`;

beforeAll(async () => {
  server = await startTestServer((req, res) => {
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    };
    switch (req.url) {
      case "/sub":
        html(page(`await fetch("/api/broken", { method: "POST" }).catch(() => {});`, `<img src="/missing.png" alt="">`));
        return;
      case "/netfail":
        html(page(`await fetch("/api/destroy").catch(() => {});`));
        return;
      case "/items":
        html(page(`await fetch("/api/items").catch(() => {});`));
        return;
      case "/items-and-other":
        html(page(`await fetch("/api/items").catch(() => {}); await fetch("/api/other").catch(() => {});`));
        return;
      case "/flaky":
        html(page(`for (let i = 0; i < 6; i++) await fetch("/api/flaky").catch(() => {});`));
        return;
      case "/server-fault":
        html(page(`await fetch("/api/server-503").catch(() => {});`));
        return;
      case "/api/server-503":
        // What @mizchi/server-faults' middleware answers with its metadata header on.
        res.writeHead(503, {
          "content-type": "text/plain",
          "x-chaos-fault-kind": "5xx",
          "x-chaos-fault-path": "/api/server-503",
          "x-chaos-fault-method": "GET",
          "x-chaos-fault-target-status": "503",
        });
        res.end("injected");
        return;
      case "/home":
        html(`<!doctype html><title>home</title><a href="/gone">gone</a>`);
        return;
      case "/api/destroy":
        req.socket.destroy();
        return;
      case "/api/items":
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      case "/api/broken":
      case "/api/other":
      case "/api/flaky":
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
        return;
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    }
  });
}, 30_000);

afterAll(async () => {
  await server.close();
});

async function crawl(path: string, options: Partial<CrawlerOptions> = {}): Promise<CrawlReport> {
  return new ChaosCrawler({
    baseUrl: `${server.url}${path}`,
    maxPages: 1,
    maxActionsPerPage: 0,
    headless: true,
    seed: 1,
    ...options,
  }).start();
}

const errorsOf = (report: CrawlReport): PageError[] => report.pages.flatMap((p) => p.errors);
const resourceLines = (report: CrawlReport) =>
  errorsOf(report).filter((e) => e.type === "console" && e.message.startsWith("Failed to load resource"));

describe("4xx / 5xx subresource and API responses", () => {
  it("puts status and method on the console error, splits summary.httpErrors, keeps the cluster key", async () => {
    const report = await crawl("/sub");
    const lines = resourceLines(report)
      .map((e) => [e.resourceUrl, e.method, e.status])
      .sort();
    expect(lines).toEqual([
      [`${server.url}/api/broken`, "POST", 500],
      [`${server.url}/missing.png`, "GET", 404],
    ]);
    // Still one console error per response: no second PageError for it.
    expect(report.summary.consoleErrors).toBe(2);
    expect(report.summary.networkErrors).toBe(0);
    expect(report.summary.httpErrors).toEqual({ total: 2, "4xx": 1, "5xx": 1, byStatus: { "404": 1, "500": 1 } });
    // The keys a baseline written before these fields has for them.
    expect(report.errorClusters.map((c) => c.key).sort()).toEqual([
      "console|Failed to load resource: the server responded with a status of <n> (Internal Server Error)",
      "console|Failed to load resource: the server responded with a status of <n> (Not Found)",
    ]);
    // Without a rule asking for it, still a pass.
    expect(exitReasons(report, {})).toEqual([]);
  }, 60_000);

  it("--fail-on-http 5xx fails on the 500 alone and names it; 4xx counts every status from 400", async () => {
    const report = await crawl("/sub");
    const where = `${server.url}/sub`;
    expect(exitReasons(report, { http: "5xx" })).toEqual([
      `--fail-on-http 5xx: 1 HTTP response >= 500 (first: POST ${server.url}/api/broken 500 on ${where})`,
    ]);
    const [reason] = exitReasons(report, { http: "4xx" });
    expect(reason).toMatch(/^--fail-on-http 4xx: 2 HTTP responses >= 400 \(first: (GET|POST) /);
    // The verdict line names them as it did: two errors.
    expect(formatQuietReport(report, { http: "5xx" })).toMatch(/^\[FAIL\] 1 pages, 2 errors, /);
  }, 60_000);

  it("leaves a URL matched by ignoreHttpPatterns out of httpErrors and drops its console line", async () => {
    const report = await crawl("/sub", { ignoreHttpPatterns: ["/missing\\.png$"] });
    expect(resourceLines(report).map((e) => e.resourceUrl)).toEqual([`${server.url}/api/broken`]);
    expect(report.summary.httpErrors).toEqual({ total: 1, "4xx": 0, "5xx": 1, byStatus: { "500": 1 } });
    expect(exitReasons(report, { http: "4xx" })).toHaveLength(1);
    expect(exitReasons(report, { http: "4xx" })[0]).toContain("1 HTTP response >= 400");
  }, 60_000);

  it("a fetch whose socket is destroyed is a network error, not an HTTP one; annotated as error only when it fails the run", async () => {
    const report = await crawl("/netfail");
    const network = errorsOf(report).filter((e) => e.type === "network");
    expect(network.map((e) => [e.message, e.method])).toEqual([[`${server.url}/api/destroy - net::ERR_EMPTY_RESPONSE`, "GET"]]);
    expect(report.summary.httpErrors?.total).toBe(0);
    expect(exitReasons(report, {})).toEqual([]);
    expect(exitReasons(report, { network: true })).toEqual([
      `--fail-on-network: 1 network error (first: GET ${server.url}/api/destroy net::ERR_EMPTY_RESPONSE on ${server.url}/netfail)`,
    ]);
    const levels = (opts: Parameters<typeof buildGithubAnnotations>[1]) =>
      buildGithubAnnotations(report, opts)
        .filter((a) => a.title.startsWith("[network]"))
        .map((a) => a.level);
    // It was ::error on a run that exited 0.
    expect(levels({})).toEqual(["warning"]);
    expect(levels({ strict: true })).toEqual(["warning"]);
    expect(levels({ network: true })).toEqual(["error"]);
  }, 60_000);

  it("annotates an HTTP console cluster as error under --strict or a --fail-on-http it meets, warning otherwise", async () => {
    const report = await crawl("/sub");
    const levels = (opts: Parameters<typeof buildGithubAnnotations>[1]) =>
      Object.fromEntries(
        buildGithubAnnotations(report, opts)
          .filter((a) => a.title.startsWith("[console]"))
          .map((a) => [a.title.includes("Not Found") ? "404" : "500", a.level]),
      );
    expect(levels({})).toEqual({ "404": "warning", "500": "warning" });
    expect(levels({ strict: true })).toEqual({ "404": "error", "500": "error" });
    expect(levels({ http: "5xx" })).toEqual({ "404": "warning", "500": "error" });
    expect(levels({ http: "4xx" })).toEqual({ "404": "error", "500": "error" });
  }, 60_000);
});

describe("the echo of a fault the run injected", () => {
  const itemsDown = () => faults.status(500, { urlPattern: /\/api\/items$/, name: "items-500" });

  it("does not fail strict chaos(), with no ignore pattern; it is tagged with the rule's name", async () => {
    const { report, passed } = await chaos({
      baseUrl: `${server.url}/items`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
      strict: true,
      failOnHttp: "5xx",
      faultInjection: [itemsDown()],
    });
    const [echo] = resourceLines(report);
    expect(echo).toMatchObject({ resourceUrl: `${server.url}/api/items`, status: 500, method: "GET", causedByFault: "items-500" });
    expect(passed).toBe(true);
    expect(report.summary.consoleErrors).toBe(0);
    expect(report.summary.httpErrors?.total).toBe(0);
    expect(report.summary.faultEchoes).toBe(1);
    expect(report.errorClusters).toEqual([]);
    expect(report.faultInjections).toEqual([{ rule: "items-500", matched: 1, injected: 1, echoes: 1 }]);
  }, 60_000);

  it("still fails strict on a real 500 from another URL", async () => {
    const { report, passed } = await chaos({
      baseUrl: `${server.url}/items-and-other`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
      strict: true,
      faultInjection: [itemsDown()],
    });
    expect(passed).toBe(false);
    expect(exitReasons(report, { strict: true })).toEqual(["--strict: 1 console error"]);
    expect(resourceLines(report).map((e) => [e.resourceUrl, e.causedByFault]).sort()).toEqual([
      [`${server.url}/api/items`, "items-500"],
      [`${server.url}/api/other`, undefined],
    ]);
    expect(report.errorClusters.map((c) => c.resourceUrls)).toEqual([[`${server.url}/api/other`]]);
  }, 60_000);

  it.each<[string, Pick<FaultRule, "schedule" | "probability">]>([
    ["a schedule that fires on the first two of six", { schedule: { decisions: ["inject", "inject", "pass"] } }],
    ["a probability", { probability: 0.5 }],
  ])("tags no more echoes on a URL than the rule fired there: %s", async (_name, decide) => {
    // The server answers every /api/flaky with a real 500: the requests the
    // rule let through are the app's own errors, on the same URL.
    const report = await crawl("/flaky", {
      faultInjection: [faults.status(500, { urlPattern: /\/api\/flaky$/, name: "flaky-500", ...decide })],
    });
    const [stats] = report.faultInjections!;
    expect(stats!.matched).toBe(6);
    expect(stats!.injected).toBeGreaterThan(0);
    expect(stats!.injected).toBeLessThan(6);
    const lines = resourceLines(report);
    expect(lines).toHaveLength(6);
    expect(lines.filter((e) => e.causedByFault === "flaky-500")).toHaveLength(stats!.injected);
    expect(stats!.echoes).toBe(stats!.injected);
    expect(report.summary.consoleErrors).toBe(6 - stats!.injected);
    expect(report.summary.httpErrors?.["5xx"]).toBe(6 - stats!.injected);
    expect(exitReasons(report, { strict: true })).toEqual([`--strict: ${6 - stats!.injected} console error${6 - stats!.injected === 1 ? "" : "s"}`]);
  }, 60_000);

  it("tags an abort's network error and its console line", async () => {
    const report = await crawl("/items", { faultInjection: [faults.abort({ urlPattern: /\/api\/items$/, name: "items-abort" })] });
    const echoes = errorsOf(report).map((e) => [e.type, e.causedByFault]);
    expect(echoes.sort()).toEqual([
      ["console", "items-abort"],
      ["network", "items-abort"],
    ]);
    expect(report.summary.networkErrors).toBe(0);
    expect(report.summary.consoleErrors).toBe(0);
    expect(report.summary.faultEchoes).toBe(2);
    expect(exitReasons(report, { strict: true, network: true })).toEqual([]);
    // Not annotated at all: it is no cluster.
    expect(buildGithubAnnotations(report, { strict: true, network: true })).toEqual([]);
  }, 60_000);

  it("tags the echo of a server-side 5xx fault in remote mode as server:5xx", async () => {
    const { report, passed } = await chaos({
      baseUrl: `${server.url}/server-fault`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
      strict: true,
      server: { mode: "remote" },
    });
    expect(resourceLines(report).map((e) => [e.status, e.causedByFault])).toEqual([[503, "server:5xx"]]);
    expect(report.serverFaults?.map((e) => e.attrs.kind)).toEqual(["5xx"]);
    expect(passed).toBe(true);
  }, 60_000);

  it("strictCountsFaultEchoes counts the echo as before: untagged, clustered, failing strict", async () => {
    const { report, passed } = await chaos({
      baseUrl: `${server.url}/items`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
      strict: true,
      strictCountsFaultEchoes: true,
      faultInjection: [itemsDown()],
    });
    expect(passed).toBe(false);
    expect(exitReasons(report, { strict: true })).toEqual(["--strict: 1 console error"]);
    expect(resourceLines(report)[0]!.causedByFault).toBeUndefined();
    expect(report.errorClusters).toHaveLength(1);
    // The rule still says what it caused.
    expect(report.faultInjections).toEqual([{ rule: "items-500", matched: 1, injected: 1, echoes: 1 }]);
  }, 60_000);
});

describe("dead links", () => {
  it("--fail-on-dead-links fails and names the first; compact and --quiet name them either way", async () => {
    const report = await crawl("/home", { maxPages: 2, seedFromSitemap: undefined });
    const dead = report.summary.discovery!.deadLinks;
    expect(dead.map((d) => [d.url, d.statusCode])).toEqual([[`${server.url}/gone`, 404]]);
    const line = `  Dead links: 1 (first: ${server.url}/gone <- ${server.url}/home)`;
    expect(exitReasons(report, {})).toEqual([]);
    expect(formatCompactReport(report).split("\n")).toContain(line);
    expect(formatQuietReport(report).split("\n")).toEqual([expect.stringMatching(/^\[PASS\] 2 pages/), line]);
    expect(exitReasons(report, { deadLinks: true })).toEqual([
      `--fail-on-dead-links: 1 dead link (first: ${server.url}/gone <- ${server.url}/home)`,
    ]);
    const quiet = formatQuietReport(report, { deadLinks: true }).split("\n");
    expect(quiet[0]).toMatch(/^\[FAIL\] /);
    expect(quiet.slice(1)).toEqual([line, `  Failed: --fail-on-dead-links: 1 dead link (first: ${server.url}/gone <- ${server.url}/home)`]);
    const level = (opts: Parameters<typeof buildGithubAnnotations>[1]) =>
      buildGithubAnnotations(report, opts).find((a) => a.title.startsWith("Dead link"))!.level;
    expect(level({})).toBe("warning");
    expect(level({ deadLinks: true })).toBe("error");
  }, 60_000);
});
