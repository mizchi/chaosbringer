import { describe, expect, it } from "vitest";
import { buildJunitXml } from "./junit.js";
import type { CrawlReport, CrawlSummary, PageError, PageResult } from "./types.js";

function summary(overrides: Partial<CrawlSummary> = {}): CrawlSummary {
  return {
    successPages: 0,
    errorPages: 0,
    timeoutPages: 0,
    recoveredPages: 0,
    pagesWithErrors: 0,
    consoleErrors: 0,
    networkErrors: 0,
    jsExceptions: 0,
    unhandledRejections: 0,
    invariantViolations: 0,
    avgLoadTime: 0,
    ...overrides,
  };
}

function page(url: string, overrides: Partial<PageResult> = {}): PageResult {
  return {
    url,
    status: "success",
    loadTime: 250,
    errors: [],
    hasErrors: false,
    warnings: [],
    links: [],
    ...overrides,
  };
}

function report(pages: PageResult[], overrides: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://localhost:3000",
    seed: 42,
    reproCommand: "chaosbringer --url http://localhost:3000",
    startTime: 0,
    endTime: 1500,
    duration: 1500,
    pagesVisited: pages.length,
    totalErrors: pages.reduce((n, p) => n + p.errors.length, 0),
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages,
    actions: [],
    summary: summary(),
    errorClusters: [],
    ...overrides,
  };
}

/**
 * The testcases flaker 0.14's `--adapter junit` import reads from `xml`, with
 * the status it gives each. @mizchi/flaker does not export its adapter (it is
 * bundled into the CLI, node_modules/@mizchi/flaker/dist/cli/main.js, region
 * `src/cli/adapters/junit.ts`, and importing that file runs the CLI), so its
 * regexes are copied here verbatim; only the fields flaker derives from
 * timing and file/line are left out.
 */
function flakerJunitParse(xml: string): { name: string; status: string; errorMessage?: string }[] {
  const getAttr = (tag: string, attr: string) => tag.match(new RegExp(`${attr}="([^"]*)"`, "i"))?.[1];
  const out: { name: string; status: string; errorMessage?: string }[] = [];
  for (const suiteBlock of xml.match(/<testsuite\s[^>]*>[\s\S]*?<\/testsuite>/g) ?? []) {
    for (const tcBlock of suiteBlock.match(/<testcase\s[^>]*(?:\/>|>[\s\S]*?<\/testcase>)/g) ?? []) {
      const tcTag = tcBlock.match(/<testcase\s[^>]*/)?.[0] ?? "";
      let status = "passed";
      let errorMessage: string | undefined;
      if (/<failure\s/.test(tcBlock)) {
        status = "failed";
        errorMessage = getAttr(tcBlock.match(/<failure\s[^>]*/)?.[0] ?? "", "message");
      } else if (/<skipped/.test(tcBlock)) status = "skipped";
      out.push({ name: getAttr(tcTag, "name") ?? "unknown", status, ...(errorMessage !== undefined ? { errorMessage } : {}) });
    }
  }
  return out;
}

describe("buildJunitXml", () => {
  it("emits a Surefire-style header with totals", () => {
    const xml = buildJunitXml(
      report([page("http://localhost:3000/"), page("http://localhost:3000/about")])
    );
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<testsuites name="http://localhost:3000"');
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('errors="0"');
    expect(xml).toContain('time="1.500"');
  });

  it("renders a passing page as a testcase with an explicit close tag", () => {
    const xml = buildJunitXml(report([page("http://localhost:3000/")]));
    expect(xml).toContain('<testcase name="/" classname="chaosbringer" time="0.250"></testcase>');
    expect(xml).not.toContain("/>");
  });

  // The baseline workflow imports this XML into flaker. A self-closed passing
  // page followed by a failing one was read as a single failed testcase: on
  // the fixture crawl, 10 pages became 8 results and the passing /form was
  // recorded as failed with /broken-link's failure.
  it("reads as one testcase per page through flaker's JUnit parser", () => {
    const err: PageError = { type: "console", message: "boom", timestamp: 0 };
    const xml = buildJunitXml(
      report([
        page("http://localhost:3000/form"),
        page("http://localhost:3000/broken-link", { errors: [err], hasErrors: true }),
        page("http://localhost:3000/about"),
      ])
    );
    expect(flakerJunitParse(xml)).toEqual([
      { name: "/form", status: "passed" },
      {
        name: "/broken-link",
        status: "failed",
        errorMessage: "1 error(s) on http://localhost:3000/broken-link: console",
      },
      { name: "/about", status: "passed" },
    ]);
  });

  it("strips the baseUrl prefix from the testcase name", () => {
    const xml = buildJunitXml(report([page("http://localhost:3000/docs/intro")]));
    expect(xml).toContain('name="/docs/intro"');
  });

  it("keeps full URLs when the page is on a different origin", () => {
    const xml = buildJunitXml(
      report([page("https://other.example.com/x")], {
        baseUrl: "http://localhost:3000",
      })
    );
    expect(xml).toContain('name="https://other.example.com/x"');
  });

  it("matches the baseUrl on a path boundary, not a raw prefix", () => {
    // /application must NOT be truncated to "lication" just because the
    // baseUrl path is /app — the testcase name must not be "lication".
    const xml = buildJunitXml(
      report([page("https://site.example.com/application")], {
        baseUrl: "https://site.example.com/app",
      })
    );
    expect(xml).not.toContain('name="lication"');
    expect(xml).toContain('name="https://site.example.com/application"');
  });

  it("strips the baseUrl prefix when the baseUrl has a path subtree", () => {
    const xml = buildJunitXml(
      report([page("https://site.example.com/app/page")], {
        baseUrl: "https://site.example.com/app",
      })
    );
    expect(xml).toContain('name="/page"');
  });

  it("preserves the leading slash even when the baseUrl ends with /", () => {
    const xml = buildJunitXml(
      report([page("http://localhost:3000/docs/intro")], {
        baseUrl: "http://localhost:3000/",
      })
    );
    expect(xml).toContain('name="/docs/intro"');
  });

  it("includes the query and hash in the test name", () => {
    const xml = buildJunitXml(
      report([page("http://localhost:3000/search?q=foo#hits")])
    );
    // attribute is XML-escaped: ? stays, # stays, & is escaped if present
    expect(xml).toContain('name="/search?q=foo#hits"');
  });

  it("falls back to the full URL when the page is on the same origin but outside the baseUrl path", () => {
    const xml = buildJunitXml(
      report([page("https://site.example.com/other")], {
        baseUrl: "https://site.example.com/app",
      })
    );
    expect(xml).toContain('name="https://site.example.com/other"');
  });

  it("emits <failure type=\"timeout\"> for status=timeout", () => {
    const xml = buildJunitXml(
      report([page("http://localhost:3000/slow", { status: "timeout" })])
    );
    expect(xml).toContain(
      '<testcase name="/slow" classname="chaosbringer" time="0.250"><failure message="navigation timeout @ http://localhost:3000/slow" type="timeout"></failure></testcase>'
    );
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('errors="0"');
    expect(xml).not.toContain("<error");
  });

  it("emits <failure type=\"error\"> for status=error with the HTTP code in the message", () => {
    const xml = buildJunitXml(
      report([page("http://localhost:3000/missing", { status: "error", statusCode: 500 })])
    );
    expect(xml).toContain('<failure message="HTTP 500 @ http://localhost:3000/missing" type="error">');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('errors="0"');
    expect(xml).not.toContain("<error");
  });

  it("says navigation error when an errored page has no HTTP code", () => {
    const xml = buildJunitXml(report([page("http://localhost:3000/gone", { status: "error" })]));
    expect(xml).toContain('<failure message="navigation error @ http://localhost:3000/gone" type="error">');
  });

  it("counts every kind of failing page once in the suite totals", () => {
    const err: PageError = { type: "console", message: "boom", timestamp: 0 };
    const xml = buildJunitXml(
      report([
        page("http://localhost:3000/"),
        page("http://localhost:3000/slow", { status: "timeout" }),
        page("http://localhost:3000/missing", { status: "error", statusCode: 404, errors: [err], hasErrors: true }),
        page("http://localhost:3000/noisy", { errors: [err], hasErrors: true }),
      ])
    );
    expect(xml).toContain('tests="4" failures="3" errors="0"');
    expect(xml.match(/<failure /g)).toHaveLength(3);
  });

  // flaker 0.14 checks a testcase for <failure> and <skipped> only, so an
  // <error> page (a navigation that timed out, or one that failed such as
  // net::ERR_EMPTY_RESPONSE) was imported as passed.
  it("reads timed-out and errored pages as failed through flaker's JUnit parser", () => {
    const xml = buildJunitXml(
      report([
        page("http://localhost:3000/"),
        page("http://localhost:3000/slow", { status: "timeout" }),
        page("http://localhost:3000/about"),
        page("http://localhost:3000/missing", { status: "error", statusCode: 500 }),
      ])
    );
    expect(flakerJunitParse(xml)).toEqual([
      { name: "/", status: "passed" },
      { name: "/slow", status: "failed", errorMessage: "navigation timeout @ http://localhost:3000/slow" },
      { name: "/about", status: "passed" },
      { name: "/missing", status: "failed", errorMessage: "HTTP 500 @ http://localhost:3000/missing" },
    ]);
  });

  it("emits <failure> for a successful page with console errors", () => {
    const err: PageError = {
      type: "console",
      message: "boom",
      timestamp: 0,
    };
    const xml = buildJunitXml(
      report([page("http://localhost:3000/", { errors: [err], hasErrors: true })])
    );
    expect(xml).toContain("<failure");
    expect(xml).toContain('failures="1"');
    expect(xml).toContain("[console] boom");
  });

  it("concatenates multiple errors into one body", () => {
    const errs: PageError[] = [
      { type: "console", message: "a", timestamp: 0 },
      { type: "exception", message: "b", timestamp: 0 },
    ];
    const xml = buildJunitXml(
      report([page("http://localhost:3000/x", { errors: errs, hasErrors: true })])
    );
    expect(xml).toContain("[console] a");
    expect(xml).toContain("[exception] b");
    expect(xml).toContain("console,exception");
  });

  it("escapes XML special characters in messages and URLs", () => {
    const err: PageError = {
      type: "console",
      message: `Error: <html> "tag" & 'quotes'`,
      timestamp: 0,
    };
    const xml = buildJunitXml(
      report([page("http://localhost:3000/?q=<x>", { errors: [err], hasErrors: true })])
    );
    expect(xml).not.toMatch(/<html>/);
    expect(xml).toContain("&lt;html&gt;");
    expect(xml).toContain("&quot;tag&quot;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&apos;quotes&apos;");
  });

  // A timed-out page's error carries Playwright's call log, coloured with
  // ANSI escapes. One ESC byte made the file malformed XML (xmllint: "PCDATA
  // invalid Char value 27").
  it("drops ANSI colour codes and control characters XML cannot carry", () => {
    const esc = String.fromCharCode(27);
    const err: PageError = {
      type: "exception",
      message: `page.goto: Timeout 30000ms exceeded.\nCall log:\n${esc}[2m  - navigating to "http://localhost:3000/slow"${esc}[22m\n`,
      timestamp: 0,
      stack: `at a${String.fromCharCode(0)}\tb${String.fromCharCode(8)}\r\n`,
    };
    const xml = buildJunitXml(report([page("http://localhost:3000/slow", { status: "timeout", errors: [err], hasErrors: true })]));
    expect(xml).toContain('Call log:\n  - navigating to &quot;http://localhost:3000/slow&quot;\n');
    expect(xml).toContain("at a\tb\r\n");
    expect(Array.from(xml).filter((ch) => ch.charCodeAt(0) < 0x20 && !"\t\n\r".includes(ch))).toEqual([]);
  });

  it("annotates invariant-violation entries with the invariant name", () => {
    const err: PageError = {
      type: "invariant-violation",
      message: "no <h1>",
      timestamp: 0,
      invariantName: "has-h1",
    };
    const xml = buildJunitXml(
      report([page("http://localhost:3000/", { errors: [err], hasErrors: true })])
    );
    expect(xml).toContain("[invariant-violation:has-h1]");
  });

  it("handles an empty report", () => {
    const xml = buildJunitXml(report([]));
    expect(xml).toContain('tests="0"');
    expect(xml).toContain("<testsuite ");
    expect(xml).toContain("</testsuite>");
  });

  it("respects custom suiteName and classname", () => {
    const xml = buildJunitXml(report([page("http://localhost:3000/")]), {
      suiteName: "smoke",
      classname: "e2e.chaos",
    });
    expect(xml).toContain('name="smoke"');
    expect(xml).toContain('classname="e2e.chaos"');
  });
});
