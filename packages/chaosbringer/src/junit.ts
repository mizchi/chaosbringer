/**
 * JUnit XML reporter.
 *
 * Render a CrawlReport as Surefire-flavoured JUnit XML so CI dashboards that
 * already understand `junit.xml` (Jenkins, CircleCI, GitLab CI, GitHub Actions
 * test summaries, Allure) can ingest chaosbringer results without bespoke
 * parsing.
 *
 * The mapping is one testcase per page:
 *   - status="error" / "timeout"            -> <error>
 *   - status="success" with errors[].length -> <failure>
 *   - everything else                       -> passing testcase, no children
 *
 * Multiple PageError entries are concatenated into one element so the XML
 * stays a flat list (most readers display only the first failure per
 * testcase anyway).
 */

import type { CrawlReport, PageError, PageResult } from "./types.js";

export interface JunitOptions {
  /** Suite name. Defaults to `report.baseUrl`. */
  suiteName?: string;
  /** Test classname. Default: "chaosbringer". */
  classname?: string;
}

export function buildJunitXml(report: CrawlReport, opts: JunitOptions = {}): string {
  const suiteName = opts.suiteName ?? report.baseUrl;
  const classname = opts.classname ?? "chaosbringer";

  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  const cases: string[] = [];

  for (const page of report.pages) {
    totalTests++;
    cases.push(renderTestcase(page, classname, report.baseUrl));
    if (page.status === "error" || page.status === "timeout") totalErrors++;
    else if (page.errors.length > 0) totalFailures++;
  }

  const time = (report.duration / 1000).toFixed(3);
  const suiteAttrs = [
    `name="${esc(suiteName)}"`,
    `tests="${totalTests}"`,
    `failures="${totalFailures}"`,
    `errors="${totalErrors}"`,
    `time="${time}"`,
  ].join(" ");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites ${suiteAttrs}>`,
    `  <testsuite ${suiteAttrs}>`,
    ...cases.map((c) => `    ${c}`),
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
}

function renderTestcase(page: PageResult, classname: string, baseUrl: string): string {
  const name = pageTestName(page.url, baseUrl);
  const time = (page.loadTime / 1000).toFixed(3);
  const head = `<testcase name="${esc(name)}" classname="${esc(classname)}" time="${time}"`;

  if (page.status === "timeout") {
    return `${head}><error message="${esc(`navigation timeout @ ${page.url}`)}" type="timeout">${esc(formatErrorBody(page))}</error></testcase>`;
  }
  if (page.status === "error") {
    const code = typeof page.statusCode === "number" ? `HTTP ${page.statusCode}` : "navigation error";
    return `${head}><error message="${esc(`${code} @ ${page.url}`)}" type="error">${esc(formatErrorBody(page))}</error></testcase>`;
  }
  if (page.errors.length > 0) {
    const types = uniqueTypes(page.errors);
    const summary = `${page.errors.length} error(s) on ${page.url}: ${types.join(", ")}`;
    return `${head}><failure message="${esc(summary)}" type="${esc(types.join(","))}">${esc(formatErrorBody(page))}</failure></testcase>`;
  }
  return `${head}/>`;
}

/**
 * Strip the baseUrl prefix so test names stay short in CI dashboards. Uses
 * URL parsing + path-boundary matching, not raw `startsWith`, so:
 *   - `baseUrl="https://site/app"` does not consume the `app` of
 *     `https://site/application` (leaving `lication`).
 *   - `baseUrl="http://localhost:3000/"` (trailing slash) preserves the
 *     leading `/` on stripped paths.
 *
 * Different origins, or pages outside the baseUrl path subtree, fall back
 * to the full URL.
 */
function pageTestName(url: string, baseUrl: string): string {
  let baseU: URL;
  let pageU: URL;
  try {
    baseU = new URL(baseUrl);
    pageU = new URL(url);
  } catch {
    return url;
  }
  if (baseU.origin !== pageU.origin) return url;

  // Strip a single trailing slash so "/" and "" behave the same.
  const basePath = baseU.pathname.replace(/\/$/, "");
  const pagePath = pageU.pathname;

  let tail: string;
  if (basePath === "") {
    tail = pagePath || "/";
  } else if (pagePath === basePath) {
    tail = "/";
  } else if (pagePath.startsWith(`${basePath}/`)) {
    tail = pagePath.slice(basePath.length);
  } else {
    // Same origin but not a descendant of baseUrl — return the full URL so
    // CI doesn't merge unrelated routes.
    return url;
  }
  return tail + pageU.search + pageU.hash;
}

function uniqueTypes(errors: readonly PageError[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errors) {
    if (!seen.has(e.type)) {
      seen.add(e.type);
      out.push(e.type);
    }
  }
  return out;
}

function formatErrorBody(page: PageResult): string {
  if (page.errors.length === 0) return "";
  return page.errors
    .map((e) => {
      const head = e.invariantName ? `[${e.type}:${e.invariantName}] ` : `[${e.type}] `;
      const stack = e.stack ? `\n${e.stack}` : "";
      return `${head}${e.message}${stack}`;
    })
    .join("\n\n");
}

/** XML attribute / text escape. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
