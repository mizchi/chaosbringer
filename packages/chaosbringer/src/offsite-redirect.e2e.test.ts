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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chaos } from "./chaos.js";
import { ChaosCrawler } from "./crawler.js";
import { dataSafety } from "./data-invariants.js";
import { buildGithubAnnotations } from "./github.js";
import { noOffsiteRedirect } from "./offsite-navigation.js";
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
      actionWeights: { scroll: 0, hover: 0, input: 0 },
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
    const link = await crawl({ baseUrl: `${base}/partner`, maxPages: 1, maxActionsPerPage: 2, actionWeights: { scroll: 0, hover: 0, input: 0 }, invariants: [noOffsiteRedirect()] });
    expect(link.actions.length).toBeGreaterThan(0);
    expect(link.actions.every((a) => a.blockedExternal)).toBe(true);
    expect(page(link, "/partner").offsiteNavigations).toBeUndefined();
    expect(getExitCode(link, { strict: true })).toBe(0);
  }, 120_000);

  it("chaos() fails the run on it through dataSafety()", async () => {
    const result = await chaos({ baseUrl: `${base}${q("/replace", `${off}/b`)}`, maxPages: 1, maxActionsPerPage: 0, headless: true, invariants: dataSafety() });
    expect(result.passed).toBe(false);
    expect(result.report.pages[0]?.errors[0]?.message).toContain("open redirect:");
  }, 120_000);
});
