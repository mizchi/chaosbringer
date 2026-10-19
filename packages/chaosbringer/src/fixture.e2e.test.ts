/**
 * `chaosbringer/fixture` under the real Playwright Test runner.
 *
 * What the fixture is given comes from the runner — `baseURL` from the
 * config's `use`, `testInfo` for attachments — and a fixture called by hand
 * would be handed whatever the test chose. So the tests themselves are a
 * Playwright suite, `fixtures/playwright-test/fixture.pw.ts`; this file serves
 * their site, runs them, and reads the runner's JSON report.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

const CONFIG = fileURLToPath(new URL("../fixtures/playwright-test/playwright.config.ts", import.meta.url));
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve("@playwright/test/cli");

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Home</title><h1>Home</h1><a href="/about">About</a>`,
  "/about": `<!doctype html><title>About</title><h1>About</h1>`,
  "/boom": `<!doctype html><title>Boom</title><script>console.error("boom")</script>`,
  // Renders what `/api/stock` answered, or a fallback when it failed.
  "/stock": `<!doctype html><title>Stock</title><p role="status">loading</p><script>
    fetch("/api/stock")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((s) => s.count + " in stock", () => "Stock unavailable")
      .then((text) => { document.querySelector("p").textContent = text; });
  </script>`,
};

/** The slice of Playwright's JSON report read here. */
interface JsonSuite {
  title: string;
  specs: { title: string; tests: { status: string; results: { errors: { message?: string }[] }[] }[] }[];
  suites?: JsonSuite[];
}
interface Outcome {
  title: string;
  status: string;
  error?: string;
}

/** Every test in the report, titled `describe › … › test` (the file's own suite left out). */
function outcomes(suites: readonly JsonSuite[], path: string[] = []): Outcome[] {
  return suites.flatMap((suite) => {
    const here = suite.title.endsWith(".pw.ts") ? path : [...path, suite.title];
    return [
      ...suite.specs.flatMap((spec) =>
        spec.tests.map((t) => ({
          title: [...here, spec.title].join(" › "),
          status: t.status,
          error: t.results.at(-1)?.errors[0]?.message,
        })),
      ),
      ...outcomes(suite.suites ?? [], here),
    ];
  });
}

describe("chaosbringer/fixture under Playwright Test", () => {
  let server: TestServer;
  let out: string;
  let report: { errors: { message?: string }[]; suites: JsonSuite[] };
  let ran: Outcome[];

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if (req.url === "/api/stock") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"count":3}`);
        return;
      }
      const body = PAGES[req.url ?? ""];
      if (body === undefined) {
        res.writeHead(req.url === "/favicon.ico" ? 204 : 404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });
    out = mkdtempSync(join(tmpdir(), "cb-pw-fixture-"));
    const reportFile = join(out, "report.json");
    // Not execFileSync: the site is served from this process, and a blocked
    // event loop would leave every page the runner asks for unanswered.
    const output = await new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [PLAYWRIGHT_CLI, "test", "--config", CONFIG],
        {
          env: {
            ...process.env,
            // Plain error messages in the report, not ANSI-coloured ones.
            FORCE_COLOR: "0",
            CHAOS_FIXTURE_BASE_URL: server.url,
            CHAOS_FIXTURE_ALT_URL: `http://localhost:${server.port}`,
            CHAOS_FIXTURE_OUTPUT_DIR: join(out, "results"),
            CHAOS_FIXTURE_REPORT: reportFile,
          },
          maxBuffer: 16 * 1024 * 1024,
        },
        // A failing test exits 1; the report says which, so read it either way.
        (_err, stdout, stderr) => resolve(`${stdout}${stderr}`),
      );
    });
    if (!existsSync(reportFile)) throw new Error(`Playwright wrote no report:\n${output}`);
    report = JSON.parse(readFileSync(reportFile, "utf8"));
    ran = outcomes(report.suites);
  }, 240_000);

  afterAll(async () => {
    await server?.close();
    if (out) rmSync(out, { recursive: true, force: true });
  });

  /** The tests titled `prefix…` ran, and every one of them passed. */
  function expectPassed(prefix: string): void {
    const matching = ran.filter((t) => t.title.startsWith(prefix));
    expect(matching.length, `no test titled "${prefix}…" ran`).toBeGreaterThan(0);
    expect(matching.filter((t) => t.status !== "expected")).toEqual([]);
  }

  it("loads the suite and passes every test in it", () => {
    expect(report.errors).toEqual([]);
    expect(ran.filter((t) => t.status !== "expected")).toEqual([]);
  });

  it("resolves a relative URL against baseURL, an explicit baseUrl first", () => {
    expectPassed("a relative URL resolves against baseURL");
  });

  it("attaches the crawl report to the test", () => {
    expectPassed("crawl() attaches its report");
  });

  it("fails the test under strict by the CLI's own exit rule, and only under strict", () => {
    expectPassed("strict");
    expectPassed("without strict, the same error is only reported");
  });

  it("passes seed, faults and invariants through to the crawler", () => {
    expectPassed("chaosOptions reach the crawler");
  });

  it("refuses a misspelled chaosOptions key, naming the one meant", () => {
    // `chaosTest.fail`: those two pass only by failing, so read why they did.
    expectPassed("a misspelled chaosOptions key");
    const error = (title: string) => ran.find((t) => t.title === `a misspelled chaosOptions key › ${title}`)?.error;
    expect(error("maxActionPerPage › is refused by name")).toMatch(
      /unknown chaosOptions key "maxActionPerPage" — did you mean "maxActionsPerPage"/,
    );
    expect(error("stirct › is refused by name")).toMatch(/unknown chaosOptions key "stirct" — did you mean "strict"/);
  });
});
