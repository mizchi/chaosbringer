import { describe, expect, it } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { buildGithubAnnotations, formatGithubAnnotation, printGithubAnnotations } from "./github.js";
import type { CrawlReport, CrawlSummary, PageError } from "./types.js";

function cluster(over: Partial<ErrorCluster> & { key: string; fingerprint: string; type: PageError["type"] }): ErrorCluster {
  const sample: PageError = {
    type: over.type,
    message: over.fingerprint,
    timestamp: 0,
  };
  return {
    key: over.key,
    type: over.type,
    fingerprint: over.fingerprint,
    sample,
    count: over.count ?? 1,
    urls: over.urls ?? [],
    invariantNames: over.invariantNames,
  };
}

function makeSummary(over: Partial<CrawlSummary> = {}): CrawlSummary {
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
    ...over,
  };
}

function makeReport(over: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://x/",
    seed: 1,
    reproCommand: "",
    startTime: 0,
    endTime: 0,
    duration: 0,
    pagesVisited: 0,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [],
    actions: [],
    summary: makeSummary(),
    errorClusters: [],
    ...over,
  };
}

describe("buildGithubAnnotations", () => {
  it("emits one annotation per error cluster", () => {
    const report = makeReport({
      errorClusters: [
        cluster({ key: "k1", type: "invariant-violation", fingerprint: "has-h1 no <h1>" }),
        cluster({ key: "k2", type: "console", fingerprint: "Failed to fetch" }),
      ],
    });
    const out = buildGithubAnnotations(report);
    expect(out).toHaveLength(2);
    expect(out[0]!.level).toBe("error");
    expect(out[0]!.title).toContain("invariant-violation");
    expect(out[1]!.level).toBe("warning");
  });

  it("upgrades warnings to errors in strict mode", () => {
    const report = makeReport({
      errorClusters: [cluster({ key: "k", type: "console", fingerprint: "f" })],
    });
    expect(buildGithubAnnotations(report, { strict: false })[0]!.level).toBe("warning");
    expect(buildGithubAnnotations(report, { strict: true })[0]!.level).toBe("error");
  });

  it("adds a separate error annotation for each dead link", () => {
    const report = makeReport({
      summary: makeSummary({
        discovery: {
          extractedLinks: 0,
          clickedLinks: 0,
          uniquePages: 0,
          deadLinks: [
            {
              url: "http://x/gone",
              statusCode: 404,
              sourceUrl: "http://x/home",
              sourceElement: "a[href='/gone']",
              method: "extracted",
            },
          ],
          spaIssues: [],
        },
      }),
    });
    const out = buildGithubAnnotations(report);
    expect(out).toHaveLength(1);
    expect(out[0]!.level).toBe("error");
    expect(out[0]!.title).toContain("Dead link");
    expect(out[0]!.message).toContain("HTTP 404");
  });

  it("includes cluster URL count in the message when multiple URLs are involved", () => {
    const report = makeReport({
      errorClusters: [
        cluster({
          key: "k",
          type: "network",
          fingerprint: "failed",
          urls: ["http://x/a", "http://x/b", "http://x/c"],
          count: 3,
        }),
      ],
    });
    const out = buildGithubAnnotations(report);
    expect(out[0]!.message).toContain("3 URLs");
    expect(out[0]!.title).toContain("×3");
  });
});

describe("formatGithubAnnotation", () => {
  it("emits the workflow-command form", () => {
    const line = formatGithubAnnotation({ level: "error", title: "boom", message: "x" });
    expect(line).toBe("::error title=boom::x");
  });

  it("escapes characters that would corrupt the property or break the line", () => {
    const line = formatGithubAnnotation({
      level: "warning",
      title: "a:b,c\nd",
      message: "hello\nworld",
    });
    expect(line).toBe("::warning title=a%3Ab%2Cc%0Ad::hello%0Aworld");
  });
});

describe("printGithubAnnotations", () => {
  it("writes one line per annotation to the sink", () => {
    const report = makeReport({
      errorClusters: [
        cluster({ key: "k", type: "exception", fingerprint: "boom" }),
      ],
    });
    const sink: string[] = [];
    printGithubAnnotations(report, { sink: (l) => sink.push(l) });
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatch(/^::error /);
  });
});
