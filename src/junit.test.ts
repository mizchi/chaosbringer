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

  it("renders a passing page as a self-closed testcase", () => {
    const xml = buildJunitXml(report([page("http://localhost:3000/")]));
    expect(xml).toContain('<testcase name="/" classname="chaosbringer" time="0.250"/>');
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

  it("emits <error> for status=timeout", () => {
    const xml = buildJunitXml(
      report([page("http://localhost:3000/slow", { status: "timeout" })])
    );
    expect(xml).toContain("<error");
    expect(xml).toContain('type="timeout"');
    expect(xml).toContain('errors="1"');
    expect(xml).not.toContain("<failure");
  });

  it("emits <error> for status=error with the HTTP code in the message", () => {
    const xml = buildJunitXml(
      report([page("http://localhost:3000/missing", { status: "error", statusCode: 500 })])
    );
    expect(xml).toContain("<error");
    expect(xml).toContain('errors="1"');
    expect(xml).toContain("HTTP 500");
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
