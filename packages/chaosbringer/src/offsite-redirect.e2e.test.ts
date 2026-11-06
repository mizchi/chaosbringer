/**
 * Pages that leave the site on their own: a script (`location.href = next`,
 * `location.replace(next)`), a meta refresh, a server 302, and a 302 to a
 * host that is down. They all passed `--strict` with nothing but a count in
 * the text report; a script redirect's `redirectedTo` named the browser's
 * error page (`chrome-error://chromewebdata/`), and a 302 to a dead host
 * failed the on-site page as `ERR_CONNECTION_REFUSED at <its own URL>`.
 *
 * The other site is a second local origin (`localhost` beside `127.0.0.1`),
 * and the dead host a closed local port. Nothing leaves the machine.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chaos } from "./chaos.js";
import { ChaosCrawler } from "./crawler.js";
import { dataSafety } from "./data-invariants.js";
import { buildGithubAnnotations } from "./github.js";
import { faults } from "./faults.js";
import { noOffsiteRedirect } from "./offsite-navigation.js";
import { runScan } from "./scan/run.js";
import { exitReasons, formatCompactReport, formatQuietReport, formatReport, getExitCode } from "./reporter.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { CrawlerOptions, CrawlReport, PageResult } from "./types.js";

describe("pages that redirect off-site", () => {
  let site: TestServer;
  let other: TestServer;
  let base: string;
  let off: string;
  let dead: string;
  const q = (path: string, next: string) => `${path}?next=${encodeURIComponent(next)}`;

  beforeAll(async () => {
    other = await startTestServer(
      (req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>other</title><p>the other site: ${req.url}</p>`);
      },
      { host: "localhost" },
    );
    off = other.url;
    // A port nothing listens on: the redirect's target refuses the connection.
    const closed = await startTestServer(() => {}, { host: "localhost" });
    dead = closed.url;
    await closed.close();
    site = await startTestServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const next = url.searchParams.get("next") ?? "/";
      const html = (body: string) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>t</title>${body}`);
      };
      switch (url.pathname) {
        case "/":
          return html(
            [
              q("/script", `${off}/a`),
              q("/replace", `${off}/b`),
              q("/meta", `${off}/e`),
              q("/r302", `${off}/c`),
              q("/dead", `${dead}/d`),
              "/chat",
              "/framed",
            ]
              .map((href) => `<a href="${href}">${href}</a>`)
              .join(" "),
          );
        case "/script":
          return html(`<script>location.href = new URLSearchParams(location.search).get("next")</script>`);
        case "/replace":
          return html(`<script>location.replace(new URLSearchParams(location.search).get("next"))</script>`);
        case "/meta":
          return html(`<meta http-equiv="refresh" content="0;url=${next}"><p>moving</p>`);
        case "/r302":
        case "/dead":
          res.writeHead(302, { location: next });
          return res.end();
        case "/chat":
          res.writeHead(302, { location: `${off}/invite` });
          return res.end();
        case "/framed":
          return html(`<p>embed</p><iframe src="${off}/embed"></iframe>`);
        case "/clicky":
          return html(`<button onclick="location.href='${off}/clicked'">Visit our partner</button>`);
        case "/partner":
          return html(`<a href="${off}/out">partner</a>`);
        case "/continue":
          // The open redirect a click sets off: the target is still the page's own ?next=.
          return html(`<button onclick="location.href = new URLSearchParams(location.search).get('next')">Continue</button>`);
        case "/form":
          // A form posted to an endpoint of the site's own that redirects off-site.
          return html(
            `<form method="get" action="/r302"><input type="hidden" name="next" value="${off}/formhit"><button>Sign in</button></form>`,
          );
        case "/blank":
          return html(`<script>location.href = "about:blank"</script>`);
        case "/old":
          // A same-site redirect whose target fails: still the site's own failed load.
          res.writeHead(302, { location: "/reset" });
          return res.end();
        case "/reset":
          return req.socket.destroy();
        default:
          res.writeHead(404);
          return res.end();
      }
    });
    base = site.url;
  }, 30_000);

  afterAll(async () => {
    await site.close();
    await other.close();
  });

  const crawl = (options: Partial<CrawlerOptions> = {}) =>
    new ChaosCrawler({ baseUrl: `${base}/`, maxPages: 8, maxActionsPerPage: 0, headless: true, timeout: 10_000, ...options }).start();
  const page = (report: CrawlReport, path: string): PageResult => {
    const found = report.pages.find((p) => new URL(p.url).pathname === path);
    if (!found) throw new Error(`no page ${path} in ${report.pages.map((p) => p.url).join(", ")}`);
    return found;
  };

  describe("without the check", () => {
    let report: CrawlReport;
    beforeAll(async () => {
      report = await crawl();
    }, 120_000);

    it("records the URL a script redirect was blocked at, never the browser's error page", () => {
      for (const [path, target] of [
        ["/script", `${off}/a`],
        ["/replace", `${off}/b`],
        ["/meta", `${off}/e`],
      ] as const) {
        const p = page(report, path);
        expect(p.redirectedTo, path).toBe(target);
        expect(p.blockedNavigations, path).toEqual([target]);
        expect(p.warnings, path).toContain(`redirected off-site to ${target}; not crawled`);
      }
    });

    it("classifies each by what started it, and whether the page's own URL named the target", () => {
      const nav = (path: string) => page(report, path).offsiteNavigations;
      expect(nav("/script")).toEqual([
        { from: `${base}${q("/script", `${off}/a`)}`, to: `${off}/a`, trigger: "script", reflected: { in: "query", param: "next" } },
      ]);
      expect(nav("/replace")?.map((n) => [n.trigger, n.reflected?.in])).toEqual([["script", "query"]]);
      expect(nav("/meta")?.map((n) => [n.trigger, n.reflected?.in])).toEqual([["meta-refresh", "query"]]);
      expect(nav("/r302")?.map((n) => [n.trigger, n.to, n.reflected?.in])).toEqual([["server-redirect", `${off}/c`, "query"]]);
      expect(nav("/chat")).toEqual([{ from: `${base}/chat`, to: `${off}/invite`, trigger: "server-redirect" }]);
      expect(nav("/framed")).toEqual([{ from: `${base}/framed`, to: `${off}/embed`, trigger: "frame" }]);
      expect(page(report, "/framed").redirectedTo).toBeUndefined();
    });

    it("calls a 302 to a host that is down an off-site redirect, not a failed load of the on-site page", () => {
      const p = page(report, "/dead");
      expect(p.status).toBe("success");
      expect(p.errors).toEqual([]);
      expect(p.redirectedTo).toBe(`${dead}/d`);
      expect(p.blockedNavigations).toEqual([`${dead}/d`]);
      expect(p.offsiteNavigations?.[0]).toMatchObject({ trigger: "server-redirect", to: `${dead}/d`, reflected: { in: "query", param: "next" } });
      expect(p.offsiteNavigations?.[0]?.failed).toMatch(/^net::ERR_CONNECTION_REFUSED/);
      expect(p.warnings.join("\n")).toMatch(/redirected off-site to .*\/d, which failed to load \(net::ERR_CONNECTION_REFUSED/);
      expect(report.summary.errorPages).toBe(0);
    });

    it("passes the run, and lists every off-site navigation in the text and compact reports", () => {
      expect(getExitCode(report, { strict: true })).toBe(0);
      const text = formatReport(report);
      expect(text).toContain("OFF-SITE NAVIGATIONS");
      expect(text).toContain(`  ${base}${q("/script", `${off}/a`)} -> ${off}/a (script redirect; target from the "next" query parameter)`);
      expect(text).toContain(`  ${base}/chat -> ${off}/invite (server redirect)`);
      expect(text).toContain(`  ${base}/framed -> ${off}/embed (iframe)`);
      // Six redirects: the iframe is not one.
      const line = formatCompactReport(report, { strict: true }).split("\n").find((l) => l.startsWith("  Off-site redirects:"));
      expect(line).toBe(`  Off-site redirects: 6 (first: ${base}${q("/script", `${off}/a`)} -> ${off}/a)`);
      expect(formatQuietReport(report, { strict: true }).split("\n")).toContain(line);
    });

    it("annotates them as warnings (reflected) or notices, since nothing fails the run on them", () => {
      const annotations = buildGithubAnnotations(report, { strict: true }).filter((a) => a.title.startsWith("Off-site redirect"));
      expect(annotations).toHaveLength(6);
      expect(annotations.find((a) => a.message.includes("/chat"))?.level).toBe("notice");
      expect(annotations.find((a) => a.message.includes("/script"))?.level).toBe("warning");
    });
  });

  it("dataSafety() fails each page that redirected, and calls a reflected target an open redirect", async () => {
    const report = await crawl({ invariants: dataSafety() });
    expect(getExitCode(report)).toBe(1);
    expect(exitReasons(report)[0]).toBe("6 invariant violations");
    const script = page(report, "/script");
    expect(script.errors.map((e) => e.message)).toEqual([
      `[navigation.no-offsite-redirect] open redirect: ${base}${q("/script", `${off}/a`)} -> ${off}/a (script redirect, to the URL in its "next" query parameter)`,
    ]);
    expect(page(report, "/chat").errors.map((e) => e.message)).toEqual([
      `[navigation.no-offsite-redirect] off-site redirect: ${base}/chat -> ${off}/invite (server redirect)`,
    ]);
    expect(page(report, "/dead").errors[0]?.message).toMatch(/open redirect: .* \(server redirect, to the URL in its "next" query parameter; it failed to load: net::ERR_CONNECTION_REFUSED/);
    // Not an iframe's navigation. (The blocked request is a network error
    // of its own, ERR_BLOCKED_BY_CLIENT, as it always was.)
    const violations = (path: string) => page(report, path).errors.filter((e) => e.type === "invariant-violation");
    expect(violations("/framed")).toEqual([]);
    expect(violations("/")).toEqual([]);
    // The violation is the run's error, so the annotation is too.
    const annotations = buildGithubAnnotations(report, {});
    expect(annotations.filter((a) => a.title.startsWith("[invariant-violation]")).every((a) => a.level === "error")).toBe(true);
    expect(annotations.filter((a) => a.title.startsWith("Off-site redirect"))).toEqual([]);
  }, 120_000);

  it("lets an allowed origin through, such as an SSO provider", async () => {
    const report = await crawl({ baseUrl: `${base}/chat`, maxPages: 1, invariants: [noOffsiteRedirect({ allow: [off] })] });
    expect(page(report, "/chat").errors).toEqual([]);
    expect(getExitCode(report)).toBe(0);
  }, 120_000);

  it("keeps a click benign, and never clicks a link straight to another origin", async () => {
    const report = await crawl({
      baseUrl: `${base}/clicky`,
      maxPages: 1,
      maxActionsPerPage: 4,
      actionWeights: { scroll: 0 },
      invariants: [noOffsiteRedirect()],
    });
    const p = page(report, "/clicky");
    expect(p.errors.filter((e) => e.type === "invariant-violation")).toEqual([]);
    expect(p.offsiteNavigations?.length).toBeGreaterThan(0);
    expect(p.offsiteNavigations?.every((n) => n.trigger === "click" && n.to === `${off}/clicked`)).toBe(true);
    expect(p.blockedNavigations?.every((u) => u === `${off}/clicked`)).toBe(true);
    // The step names where it was sent, not the browser's error page.
    const left = report.actions.filter((a) => a.leftSiteTo);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((a) => a.leftSiteTo === `${off}/clicked`)).toBe(true);
    expect(getExitCode(report, { strict: true })).toBe(0);
    // A link to another origin is not clicked at all, so nothing navigates.
    const link = await crawl({ baseUrl: `${base}/partner`, maxPages: 1, maxActionsPerPage: 2, actionWeights: { scroll: 0 }, invariants: [noOffsiteRedirect()] });
    expect(link.actions.length).toBeGreaterThan(0);
    expect(link.actions.every((a) => a.blockedExternal)).toBe(true);
    expect(page(link, "/partner").offsiteNavigations).toBeUndefined();
    expect(getExitCode(link, { strict: true })).toBe(0);
  }, 120_000);

  it("flags a click that follows the page's own ?next=, and a form whose endpoint redirects off-site", async () => {
    const steps = { maxPages: 1, maxActionsPerPage: 3, actionWeights: { scroll: 0 }, invariants: dataSafety(), seed: 3 };
    const cont = await crawl({ ...steps, baseUrl: `${base}${q("/continue", `${off}/phish`)}` });
    const c = page(cont, "/continue");
    expect(c.offsiteNavigations?.length).toBeGreaterThan(0);
    expect(c.offsiteNavigations?.every((n) => n.trigger === "script" && n.to === `${off}/phish` && n.reflected?.in === "query")).toBe(true);
    expect(c.errors.filter((e) => e.type === "invariant-violation").map((e) => e.message)).toEqual([
      `[navigation.no-offsite-redirect] open redirect: ${base}${q("/continue", `${off}/phish`)} -> ${off}/phish (script redirect, to the URL in its "next" query parameter)`,
    ]);
    expect(getExitCode(cont)).toBe(1);
    // Listed once in the compact line, however many clicks set it off.
    expect(formatCompactReport(cont, {}).split("\n")).toContain(
      `  Off-site redirects: 1 (first: ${base}${q("/continue", `${off}/phish`)} -> ${off}/phish)`,
    );

    const form = await crawl({ ...steps, baseUrl: `${base}/form` });
    const f = page(form, "/form");
    expect(f.offsiteNavigations?.length).toBeGreaterThan(0);
    for (const nav of f.offsiteNavigations ?? []) {
      // Named by the endpoint that redirected, which is where the target came from.
      expect(nav).toMatchObject({ to: `${off}/formhit`, trigger: "server-redirect", reflected: { in: "query", param: "next" } });
      expect(new URL(nav.from).pathname).toBe("/r302");
    }
    expect(f.errors.filter((e) => e.type === "invariant-violation")).toHaveLength(1);
    expect(f.errors[0]?.offsiteRedirect).toBe(true);
    expect(getExitCode(form)).toBe(1);
  }, 120_000);

  it("records no off-site navigation for a page that went to about:blank", async () => {
    const report = await crawl({ baseUrl: `${base}/blank`, maxPages: 1, invariants: dataSafety() });
    const p = page(report, "/blank");
    expect(p.offsiteNavigations).toBeUndefined();
    expect(p.blockedNavigations).toBeUndefined();
    expect(p.errors.filter((e) => e.type === "invariant-violation")).toEqual([]);
    expect(getExitCode(report)).toBe(0);
  }, 120_000);

  it("keeps a failed same-site redirect a failed load of the page, not an off-site redirect", async () => {
    const report = await crawl({ baseUrl: `${base}/old`, maxPages: 1, invariants: dataSafety() });
    const p = page(report, "/old");
    expect(p.status).toBe("error");
    expect(p.errors.map((e) => [e.type, e.redirected])).toEqual([["navigation", true]]);
    expect(p.offsiteNavigations).toBeUndefined();
    expect(p.redirectedTo).toBeUndefined();
  }, 120_000);

  it("classifies them the same through the fault route (any --faults run), and dataSafety() fails them there too", async () => {
    // A rule that matches nothing still puts every request through the route.
    const report = await crawl({
      invariants: dataSafety(),
      faultInjection: [faults.status(500, { urlPattern: /\/never-requested$/ })],
    });
    const triggers = (path: string) => page(report, path).offsiteNavigations?.map((n) => n.trigger);
    expect(triggers("/script")).toEqual(["script"]);
    expect(triggers("/replace")).toEqual(["script"]);
    expect(triggers("/meta")).toEqual(["meta-refresh"]);
    expect(triggers("/r302")).toEqual(["server-redirect"]);
    expect(triggers("/framed")).toEqual(["frame"]);
    const violations = (path: string) =>
      page(report, path)
        .errors.filter((e) => e.type === "invariant-violation")
        .map((e) => e.message);
    expect(violations("/script")[0]).toMatch(/^\[navigation\.no-offsite-redirect\] open redirect: /);
    expect(violations("/meta")[0]).toMatch(/^\[navigation\.no-offsite-redirect\] open redirect: .*\(meta refresh, /);
    expect(violations("/framed")).toEqual([]);
  }, 120_000);

  it("replays a click from a trace as a click, not as the page redirecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chaos-offsite-replay-"));
    try {
      const traceOut = join(dir, "clicky.jsonl");
      const options = { baseUrl: `${base}/clicky`, maxPages: 1, maxActionsPerPage: 2, actionWeights: { scroll: 0 }, invariants: [noOffsiteRedirect()] };
      const recorded = await crawl({ ...options, traceOut });
      expect(page(recorded, "/clicky").offsiteNavigations?.length).toBeGreaterThan(0);
      const replayed = await crawl({ ...options, traceReplay: traceOut });
      const p = page(replayed, "/clicky");
      expect(p.offsiteNavigations?.length).toBeGreaterThan(0);
      expect(p.offsiteNavigations?.every((n) => n.trigger === "click")).toBe(true);
      expect(p.errors.filter((e) => e.type === "invariant-violation")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("scan leaves out of open-redirect what a noOffsiteRedirect({ allow }) of crawler.invariants allows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chaos-offsite-scan-"));
    try {
      const scan = (crawler: { invariants?: ReturnType<typeof noOffsiteRedirect>[] }, extra: { offsiteRedirectAllow?: string[] } = {}) =>
        runScan({ url: `${base}/chat`, maxPages: 1, maxActionsPerPage: 0, chaos: false, coverage: false, seed: 1, outDir: dir, crawler: { headless: true, ...crawler }, ...extra });
      const plain = await scan({});
      expect(plain.analysis.findings.filter((f) => f.rule === "open-redirect").map((f) => f.severity)).toEqual(["low"]);
      const allowed = await scan({ invariants: [noOffsiteRedirect({ name: "sso", allow: [off] })] });
      expect(allowed.analysis.findings.filter((f) => f.rule === "open-redirect" || f.rule === "invariant-violation")).toEqual([]);
      const byOption = await scan({}, { offsiteRedirectAllow: [off] });
      expect(byOption.analysis.findings.filter((f) => f.rule === "open-redirect")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("chaos() fails the run on it through dataSafety()", async () => {
    const result = await chaos({ baseUrl: `${base}${q("/replace", `${off}/b`)}`, maxPages: 1, maxActionsPerPage: 0, headless: true, invariants: dataSafety() });
    expect(result.passed).toBe(false);
    expect(result.report.pages[0]?.errors[0]?.message).toContain("open redirect:");
  }, 120_000);
});
