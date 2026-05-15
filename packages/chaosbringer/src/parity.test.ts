import { describe, expect, it, vi } from "vitest";
import { runParity, type BrowserLike, type ContextLike, type PageLike } from "./parity.js";

/**
 * Minimal fake of the Playwright surface `probeBrowserSide` uses. Each
 * test seeds error lists per URL; the fake replays them through the
 * `pageerror` / `console` event handlers when `page.goto(url)` runs.
 */
function makeBrowserLauncher(
  errorsByUrl: Record<string, { pageErrors?: string[]; consoleErrors?: string[] }>,
): () => Promise<BrowserLike> {
  return async () => ({
    async newContext(): Promise<ContextLike> {
      return {
        async newPage(): Promise<PageLike> {
          let pageErrorHandler: ((err: Error) => void) | null = null;
          let consoleHandler:
            | ((msg: { type(): string; text(): string }) => void)
            | null = null;
          return {
            on(event: string, handler: (...args: unknown[]) => void) {
              if (event === "pageerror") pageErrorHandler = handler as (err: Error) => void;
              if (event === "console")
                consoleHandler = handler as (msg: { type(): string; text(): string }) => void;
            },
            async goto(url: string) {
              const seeded = errorsByUrl[url] ?? {};
              for (const msg of seeded.pageErrors ?? []) {
                pageErrorHandler?.(new Error(msg));
              }
              for (const msg of seeded.consoleErrors ?? []) {
                consoleHandler?.({ type: () => "error", text: () => msg });
              }
            },
          };
        },
        async close() {},
      };
    },
    async close() {},
  });
}

function makeFetcher(handlers: Record<string, () => Response | Promise<Response> | Promise<never>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  }) as typeof fetch;
}

describe("runParity", () => {
  it("report carries a schemaVersion + config echo so consumers can validate", async () => {
    const fetcher = makeFetcher({
      "http://l/x": () => new Response("", { status: 200 }),
      "http://r/x": () => new Response("", { status: 200 }),
    });
    const report = await runParity({
      left: "http://l",
      right: "http://r",
      paths: ["x"],
      checkBody: true,
      checkHeaders: ["content-type"],
      perfDeltaMs: 50,
      fetcher,
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.config).toEqual({
      checkBody: true,
      checkHeaders: ["content-type"],
      checkExceptions: false,
      followRedirects: false,
      timeoutMs: 10000,
      perfDeltaMs: 50,
    });
  });

  it("classifies matching paths as match (no mismatch)", async () => {
    const fetcher = makeFetcher({
      "http://left/foo": () => new Response("", { status: 200 }),
      "http://right/foo": () => new Response("", { status: 200 }),
    });
    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["foo"],
      fetcher,
    });
    expect(report.mismatches).toHaveLength(0);
    expect(report.matches).toHaveLength(1);
  });

  it("flags a status mismatch when status codes differ", async () => {
    const fetcher = makeFetcher({
      "http://left/api": () => new Response("", { status: 200 }),
      "http://right/api": () => new Response("", { status: 500 }),
    });
    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["api"],
      fetcher,
    });
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].kinds[0]).toBe("status");
    expect(report.mismatches[0].left.status).toBe(200);
    expect(report.mismatches[0].right.status).toBe(500);
  });

  it("flags a redirect mismatch when 3xx Location differs", async () => {
    const fetcher = makeFetcher({
      "http://left/old": () =>
        new Response("", { status: 301, headers: { location: "/new" } }),
      "http://right/old": () =>
        new Response("", { status: 301, headers: { location: "/elsewhere" } }),
    });
    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["old"],
      fetcher,
    });
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].kinds[0]).toBe("redirect");
    expect(report.mismatches[0].left.location).toBe("/new");
    expect(report.mismatches[0].right.location).toBe("/elsewhere");
  });

  it("does not flag redirect on 3xx when Location matches", async () => {
    const fetcher = makeFetcher({
      "http://left/r": () =>
        new Response("", { status: 302, headers: { location: "/dest" } }),
      "http://right/r": () =>
        new Response("", { status: 302, headers: { location: "/dest" } }),
    });
    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["r"],
      fetcher,
    });
    expect(report.mismatches).toHaveLength(0);
  });

  it("flags a failure mismatch when one side throws and the other succeeds", async () => {
    const fetcher = makeFetcher({
      "http://left/x": () => Promise.reject(new Error("ECONNREFUSED")),
      "http://right/x": () => new Response("", { status: 200 }),
    });
    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["x"],
      fetcher,
    });
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].kinds[0]).toBe("failure");
    expect(report.mismatches[0].left.error).toContain("ECONNREFUSED");
    expect(report.mismatches[0].right.status).toBe(200);
  });

  it("treats both-sides-failed as a match (per spec: only one-side failures count)", async () => {
    const fetcher = makeFetcher({
      "http://left/y": () => Promise.reject(new Error("down")),
      "http://right/y": () => Promise.reject(new Error("down")),
    });
    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["y"],
      fetcher,
    });
    expect(report.mismatches).toHaveLength(0);
    expect(report.matches).toHaveLength(1);
  });

  it("joins base URL + path without double-slashing", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input.toString();
      seen.push(u);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await runParity({
      left: "http://left",
      right: "http://right/",
      paths: ["/foo", "bar"],
      fetcher,
    });
    expect(seen).toEqual([
      "http://left/foo",
      "http://right/foo",
      "http://left/bar",
      "http://right/bar",
    ]);
  });

  it("passes redirect: 'manual' by default, 'follow' when followRedirects=true", async () => {
    const seenInit: Array<RequestInit | undefined> = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit.push(init);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await runParity({
      left: "http://l",
      right: "http://r",
      paths: ["/x"],
      fetcher,
    });
    expect(seenInit[0]?.redirect).toBe("manual");

    seenInit.length = 0;
    await runParity({
      left: "http://l",
      right: "http://r",
      paths: ["/x"],
      followRedirects: true,
      fetcher,
    });
    expect(seenInit[0]?.redirect).toBe("follow");
  });

  it("aborts a slow request after timeoutMs and records the error", async () => {
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Honour the abort signal so the timeout actually fires.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted by timeout"));
        });
      });
    }) as typeof fetch;

    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["slow"],
      timeoutMs: 5,
      fetcher,
    });
    // Both sides hit the same timeout, so they "match" per the both-failed rule.
    expect(report.mismatches).toHaveLength(0);
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0].left.error).toBeDefined();
    expect(report.matches[0].right.error).toBeDefined();
  });

  describe("checkBody", () => {
    it("flags a body mismatch when status agrees but bytes differ", async () => {
      const fetcher = makeFetcher({
        "http://left/api": () =>
          new Response(JSON.stringify({ id: 1, email: "a@x" }), { status: 200 }),
        "http://right/api": () =>
          new Response(JSON.stringify({ id: 1 }), { status: 200 }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        checkBody: true,
        fetcher,
      });
      expect(report.mismatches).toHaveLength(1);
      const m = report.mismatches[0];
      expect(m.kinds[0]).toBe("body");
      // bodyLength + bodyHash populated on both sides so a consumer of
      // the JSON report can prove the drift without refetching.
      expect(m.left.bodyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(m.right.bodyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(m.left.bodyHash).not.toBe(m.right.bodyHash);
      expect(m.left.bodyLength).toBeGreaterThan(m.right.bodyLength!);
    });

    it("treats identical bodies as a match", async () => {
      const payload = '{"id":1,"email":"a@x"}';
      const fetcher = makeFetcher({
        "http://left/api": () => new Response(payload, { status: 200 }),
        "http://right/api": () => new Response(payload, { status: 200 }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        checkBody: true,
        fetcher,
      });
      expect(report.mismatches).toHaveLength(0);
      expect(report.matches[0].left.bodyHash).toBe(report.matches[0].right.bodyHash);
    });

    it("does not populate bodyHash when checkBody is off (default)", async () => {
      const fetcher = makeFetcher({
        "http://left/api": () => new Response("a", { status: 200 }),
        "http://right/api": () => new Response("b", { status: 200 }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        fetcher,
      });
      // Different bytes, but checkBody off → no body mismatch fires.
      expect(report.mismatches).toHaveLength(0);
      expect(report.matches[0].left.bodyHash).toBeUndefined();
    });

    it("status mismatch still wins over body mismatch", async () => {
      // If status already differs, body comparison is redundant noise.
      const fetcher = makeFetcher({
        "http://left/x": () => new Response("a", { status: 200 }),
        "http://right/x": () => new Response("b", { status: 500 }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkBody: true,
        fetcher,
      });
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0].kinds[0]).toBe("status");
    });
  });

  describe("checkHeaders", () => {
    it("flags a header mismatch when a named header differs", async () => {
      const fetcher = makeFetcher({
        "http://left/api": () =>
          new Response("", { status: 200, headers: { "cache-control": "max-age=60" } }),
        "http://right/api": () =>
          new Response("", { status: 200, headers: { "cache-control": "no-store" } }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        checkHeaders: ["cache-control"],
        fetcher,
      });
      expect(report.mismatches).toHaveLength(1);
      const m = report.mismatches[0];
      expect(m.kinds[0]).toBe("header");
      expect(m.left.headers?.["cache-control"]).toBe("max-age=60");
      expect(m.right.headers?.["cache-control"]).toBe("no-store");
    });

    it("distinguishes 'absent' from 'empty' in the captured header map", async () => {
      const fetcher = makeFetcher({
        "http://left/api": () =>
          new Response("", { status: 200, headers: { "x-custom": "value" } }),
        "http://right/api": () => new Response("", { status: 200 }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        checkHeaders: ["x-custom"],
        fetcher,
      });
      expect(report.mismatches[0].right.headers?.["x-custom"]).toBeNull();
    });

    it("is case-insensitive on the input list (lowercase normalised internally)", async () => {
      const fetcher = makeFetcher({
        "http://left/api": () =>
          new Response("", { status: 200, headers: { "content-type": "text/html" } }),
        "http://right/api": () =>
          new Response("", { status: 200, headers: { "content-type": "application/json" } }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        checkHeaders: ["Content-Type"],
        fetcher,
      });
      expect(report.mismatches[0].kinds[0]).toBe("header");
      expect(report.mismatches[0].left.headers?.["content-type"]).toBe("text/html");
    });

    it("does not flag headers that aren't in the list (no over-broad detection)", async () => {
      const fetcher = makeFetcher({
        "http://left/api": () =>
          new Response("", { status: 200, headers: { "x-internal": "a" } }),
        "http://right/api": () =>
          new Response("", { status: 200, headers: { "x-internal": "b" } }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        checkHeaders: ["cache-control"], // not the differing one
        fetcher,
      });
      expect(report.mismatches).toHaveLength(0);
    });

    it("header drift reported before body drift when both differ", async () => {
      // A header-policy change (cache-control TTL, CORS origin) is the
      // upstream cause; the body difference is downstream noise.
      // Reporting header first keeps the triage signal clean.
      const fetcher = makeFetcher({
        "http://left/api": () =>
          new Response("body-a", { status: 200, headers: { "cache-control": "max-age=60" } }),
        "http://right/api": () =>
          new Response("body-b", { status: 200, headers: { "cache-control": "no-store" } }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["api"],
        checkBody: true,
        checkHeaders: ["cache-control"],
        fetcher,
      });
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0].kinds[0]).toBe("header");
    });

    it("an empty/unset checkHeaders list does not populate the headers map", async () => {
      const fetcher = makeFetcher({
        "http://left/x": () => new Response("", { status: 200 }),
        "http://right/x": () => new Response("", { status: 200 }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        fetcher,
      });
      expect(report.matches[0].left.headers).toBeUndefined();
    });
  });

  describe("checkExceptions", () => {
    it("flags an exception mismatch when right has a JS error left doesn't", async () => {
      const fetcher = makeFetcher({
        "http://left/admin": () => new Response("", { status: 200 }),
        "http://right/admin": () => new Response("", { status: 200 }),
      });
      const browserLauncher = makeBrowserLauncher({
        "http://left/admin": {},
        "http://right/admin": { pageErrors: ["ReferenceError: x is not defined"] },
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["admin"],
        checkExceptions: true,
        fetcher,
        browserLauncher,
      });
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0].kinds[0]).toBe("exception");
      expect(report.mismatches[0].right.pageErrors).toEqual([
        "ReferenceError: x is not defined",
      ]);
      expect(report.mismatches[0].left.pageErrors).toEqual([]);
    });

    it("collapses different source locations to the same fingerprint (no false positive)", async () => {
      // The same bug fires from `app.js:123:5` on left and `app.js:124:9` on
      // right after a recompile. Without normalisation this would be a
      // false-positive exception mismatch.
      const fetcher = makeFetcher({
        "http://left/x": () => new Response("", { status: 200 }),
        "http://right/x": () => new Response("", { status: 200 }),
      });
      const browserLauncher = makeBrowserLauncher({
        "http://left/x": { pageErrors: ["TypeError: foo at bundle.js:123:5"] },
        "http://right/x": { pageErrors: ["TypeError: foo at bundle.js:124:9"] },
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkExceptions: true,
        fetcher,
        browserLauncher,
      });
      expect(report.mismatches).toHaveLength(0);
    });

    it("treats console.error as part of the exception set", async () => {
      const fetcher = makeFetcher({
        "http://left/x": () => new Response("", { status: 200 }),
        "http://right/x": () => new Response("", { status: 200 }),
      });
      const browserLauncher = makeBrowserLauncher({
        "http://left/x": {},
        "http://right/x": { consoleErrors: ["api failed"] },
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkExceptions: true,
        fetcher,
        browserLauncher,
      });
      expect(report.mismatches[0].kinds[0]).toBe("exception");
      expect(report.mismatches[0].right.consoleErrors).toEqual(["api failed"]);
    });

    it("status mismatch wins over exception mismatch", async () => {
      // A status difference is the upstream signal; whatever JS error
      // the broken response causes is downstream noise.
      const fetcher = makeFetcher({
        "http://left/x": () => new Response("", { status: 200 }),
        "http://right/x": () => new Response("", { status: 500 }),
      });
      const browserLauncher = makeBrowserLauncher({
        "http://left/x": {},
        "http://right/x": { pageErrors: ["error"] },
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkExceptions: true,
        fetcher,
        browserLauncher,
      });
      expect(report.mismatches[0].kinds[0]).toBe("status");
    });

    it("matched probes carry the empty error arrays so consumers can prove cleanliness", async () => {
      const fetcher = makeFetcher({
        "http://left/x": () => new Response("", { status: 200 }),
        "http://right/x": () => new Response("", { status: 200 }),
      });
      const browserLauncher = makeBrowserLauncher({
        "http://left/x": {},
        "http://right/x": {},
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkExceptions: true,
        fetcher,
        browserLauncher,
      });
      expect(report.mismatches).toHaveLength(0);
      expect(report.matches[0].left.pageErrors).toEqual([]);
      expect(report.matches[0].right.pageErrors).toEqual([]);
    });

    it("does not load a browser when checkExceptions is off", async () => {
      const fetcher = makeFetcher({
        "http://left/x": () => new Response("", { status: 200 }),
        "http://right/x": () => new Response("", { status: 200 }),
      });
      const browserLauncher = vi.fn();
      await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        fetcher,
        browserLauncher: browserLauncher as never,
      });
      expect(browserLauncher).not.toHaveBeenCalled();
    });
  });

  describe("perf threshold", () => {
    /**
     * Mock fetcher that takes a fixed time to resolve per URL. We
     * spin a real `setTimeout` (not fake timers) because parity's
     * timing is wall-clock — Date.now / performance.now under
     * fake timers wouldn't advance, defeating the test.
     */
    function makeTimedFetcher(timings: Record<string, number>): typeof fetch {
      return (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const ms = timings[url] ?? 0;
        if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
    }

    it("flags a perf mismatch when right is slower than left by more than the delta budget", async () => {
      // Margins sized for contended CI runners: 0ms baseline can
      // measure as 50ms+ under event-loop contention, so the right
      // wait and threshold both need generous headroom above that
      // floor. 200ms vs 0ms with an 80ms threshold survives even when
      // the runner adds ~80ms of jitter to either side.
      const fetcher = makeTimedFetcher({
        "http://left/x": 0,
        "http://right/x": 200,
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        perfDeltaMs: 80,
        fetcher,
      });
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0].kinds).toContain("perf");
      expect(report.mismatches[0].left.durationMs).toBeLessThan(
        report.mismatches[0].right.durationMs!,
      );
    });

    it("does not flag perf when the delta is below the budget", async () => {
      // Both sides 0ms so the asymmetric wait can't trip the
      // threshold; budget set well above any plausible jitter delta
      // between two same-event-loop awaits on a busy CI runner.
      const fetcher = makeTimedFetcher({
        "http://left/x": 0,
        "http://right/x": 0,
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        perfDeltaMs: 150,
        fetcher,
      });
      expect(report.mismatches).toHaveLength(0);
    });

    it("perfRatio fires independently of perfDeltaMs", async () => {
      // Use a wide left/right spread so a few-ms of measurement jitter
      // on `left` can't drag the ratio below the threshold. With
      // left=10ms (so the ratio path doesn't skip on 0) and right=300ms
      // and a 2x threshold, even a +50ms CI jitter on left (60ms
      // measured) keeps ratio at 5+ — well clear of 2x.
      const fetcher = makeTimedFetcher({
        "http://left/x": 10,
        "http://right/x": 300,
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        perfRatio: 2.0,
        fetcher,
      });
      expect(report.mismatches[0]?.kinds).toContain("perf");
    });

    it("perfRatio skips when left.durationMs is 0 (avoid divide-by-zero on instant responses)", async () => {
      // Synthesize a 0-duration left: handler resolves immediately
      // without await. Right takes longer. Ratio would be Infinity;
      // the code must skip rather than report bogus drift.
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("left")) return new Response("ok", { status: 200 });
        await new Promise((r) => setTimeout(r, 20));
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        perfRatio: 2.0, // would fire on any non-zero right if left=0
        fetcher,
      });
      // Depending on timing left might be 0 or ~0.1ms. Either way the
      // ratio check must NOT fire on a 0/near-0 baseline. We accept
      // either 0 or 1 mismatches but assert: if a mismatch fires,
      // it must have a sensible numerator.
      if (report.mismatches.length > 0) {
        expect(report.mismatches[0].left.durationMs).toBeGreaterThan(0);
      }
    });

    it("populates durationMs on every probe (even when perf isn't checked)", async () => {
      const fetcher = (async () => new Response("ok", { status: 200 })) as typeof fetch;
      const report = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        fetcher,
      });
      expect(report.matches[0].left.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.matches[0].right.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("perf mismatch coexists with body / header on the same probe", async () => {
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("left")) {
          return new Response("a", { status: 200, headers: { "cache-control": "max-age=60" } });
        }
        await new Promise((r) => setTimeout(r, 50));
        return new Response("b", { status: 200, headers: { "cache-control": "no-store" } });
      }) as typeof fetch;
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkBody: true,
        checkHeaders: ["cache-control"],
        perfDeltaMs: 20,
        fetcher,
      });
      // All three kinds fire on the same probe.
      expect(report.mismatches[0].kinds).toEqual(
        expect.arrayContaining(["header", "body", "perf"]),
      );
    });
  });

  describe("multi-kind reporting (overlapping bugs on one path)", () => {
    it("reports BOTH header and body kinds when both differ", async () => {
      // The bug that motivated this: with single-kind reporting, a
      // header drift would mask an independent body drift on the
      // same path. Now both surface.
      const fetcher = makeFetcher({
        "http://left/x": () =>
          new Response(JSON.stringify({ id: 1 }), {
            status: 200,
            headers: { "cache-control": "max-age=60" },
          }),
        "http://right/x": () =>
          new Response(JSON.stringify({ id: 2 }), {
            status: 200,
            headers: { "cache-control": "no-store" },
          }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkBody: true,
        checkHeaders: ["cache-control"],
        fetcher,
      });
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0].kinds).toEqual(["header", "body"]);
      expect(report.mismatches[0].bodyDiff).toBeDefined();
    });

    it("status mismatch still short-circuits other checks", async () => {
      // A status difference means the downstream body / header
      // comparison is apples-to-oranges. Keep status exclusive.
      const fetcher = makeFetcher({
        "http://left/x": () =>
          new Response("a", { status: 200, headers: { "cache-control": "max-age=60" } }),
        "http://right/x": () =>
          new Response("b", { status: 500, headers: { "cache-control": "no-store" } }),
      });
      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        checkBody: true,
        checkHeaders: ["cache-control"],
        fetcher,
      });
      expect(report.mismatches[0].kinds).toEqual(["status"]);
    });
  });

  describe("perf N-sample mode", () => {
    /**
     * Fetcher that returns a fixed delay per (URL, call-index) so we
     * can mix fast samples with deliberate outliers. Each URL has a
     * queue; subsequent calls walk the queue and the last entry
     * repeats once exhausted (so a single-entry array works as a
     * fixed-time stub).
     */
    function makeQueuedTimedFetcher(timings: Record<string, number[]>): typeof fetch {
      const counters: Record<string, number> = {};
      return (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const arr = timings[url] ?? [0];
        const idx = counters[url] ?? 0;
        counters[url] = idx + 1;
        const ms = arr[Math.min(idx, arr.length - 1)];
        if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
    }

    it("populates perfStats with one entry per sample on both sides", async () => {
      const report = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        perfSamples: 5,
        fetcher: makeQueuedTimedFetcher({
          "http://l/x": [0, 0, 0, 0, 0],
          "http://r/x": [0, 0, 0, 0, 0],
        }),
      });
      const probe = report.matches[0];
      expect(probe.left.perfStats?.samples).toBe(5);
      expect(probe.right.perfStats?.samples).toBe(5);
      // p95 / p99 must be >= median by construction; serves as a
      // sanity check on the percentile math rather than a stub-tied
      // exact-millisecond comparison (which would be flaky).
      expect(probe.left.perfStats!.p95).toBeGreaterThanOrEqual(probe.left.perfStats!.median);
      expect(probe.left.perfStats!.p99).toBeGreaterThanOrEqual(probe.left.perfStats!.p95);
      // First-sample durationMs is preserved as the legacy timing.
      expect(typeof probe.left.durationMs).toBe("number");
    });

    it("leaves perfStats undefined in default (single-sample) mode", async () => {
      const report = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        fetcher: makeQueuedTimedFetcher({ "http://l/x": [0], "http://r/x": [0] }),
      });
      expect(report.matches[0].left.perfStats).toBeUndefined();
      expect(report.matches[0].right.perfStats).toBeUndefined();
    });

    it("median percentile is immune to a single high outlier; p95 catches it", async () => {
      // The whole point of N-sample: a cold-cache 100ms outlier on
      // one side would false-positive a 30ms-budget single-sample
      // perf check. Median sees through it; p95 still raises the
      // alarm so we're not blind to genuine tail-latency regressions.
      // Outlier sized for CI: a 300ms spike against a 0ms baseline
      // and a 100ms threshold survives ~80ms of per-sample jitter on
      // either side. With perfSamples=5, p95 = max sample; median = 3rd
      // sample (untouched by the single outlier).
      const timings = {
        "http://l/x": [0, 0, 0, 0, 0],
        "http://r/x": [0, 0, 0, 0, 300],
      };

      const medianReport = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        perfSamples: 5,
        perfPercentile: "median",
        perfDeltaMs: 100,
        fetcher: makeQueuedTimedFetcher(timings),
      });
      expect(medianReport.mismatches).toHaveLength(0);

      const p95Report = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        perfSamples: 5,
        perfPercentile: "p95",
        perfDeltaMs: 100,
        fetcher: makeQueuedTimedFetcher(timings),
      });
      expect(p95Report.mismatches).toHaveLength(1);
      expect(p95Report.mismatches[0].kinds).toContain("perf");
    });

    it("defaults to p95 when perfPercentile is omitted and perfSamples > 1", async () => {
      // Same outlier scenario as above. With no explicit percentile
      // the classifier must pick p95 (SLO-standard default) — so the
      // outlier trips the budget. Sized for CI jitter (see sibling
      // test).
      const report = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        perfSamples: 5,
        perfDeltaMs: 100,
        fetcher: makeQueuedTimedFetcher({
          "http://l/x": [0, 0, 0, 0, 0],
          "http://r/x": [0, 0, 0, 0, 300],
        }),
      });
      expect(report.mismatches[0]?.kinds).toContain("perf");
    });

    it("config echoes perfSamples and perfPercentile when N>1, omits them otherwise", async () => {
      const sampled = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        perfSamples: 3,
        perfPercentile: "median",
        fetcher: makeQueuedTimedFetcher({ "http://l/x": [0], "http://r/x": [0] }),
      });
      expect(sampled.config.perfSamples).toBe(3);
      expect(sampled.config.perfPercentile).toBe("median");

      const single = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        fetcher: makeQueuedTimedFetcher({ "http://l/x": [0], "http://r/x": [0] }),
      });
      // Single-sample mode keeps the legacy config shape — no
      // surprise fields on consumers who don't opt in.
      expect(single.config.perfSamples).toBeUndefined();
      expect(single.config.perfPercentile).toBeUndefined();
    });

    it("short-circuits N-sample loop when the first sample fails (no N×timeout cost on dead hosts)", async () => {
      let rightCalls = 0;
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("right")) {
          rightCalls++;
          throw new Error("ECONNREFUSED");
        }
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      const report = await runParity({
        left: "http://left",
        right: "http://right",
        paths: ["x"],
        perfSamples: 5,
        fetcher,
      });
      // Right side reports the failure kind from the single attempt.
      expect(report.mismatches[0].kinds).toContain("failure");
      expect(report.mismatches[0].right.perfStats).toBeUndefined();
      // The whole point of short-circuit: we did NOT make 5 calls
      // against a server we already know is down.
      expect(rightCalls).toBe(1);
    });

    it("clamps perfSamples=0 to the single-sample default", async () => {
      const report = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        perfSamples: 0,
        fetcher: makeQueuedTimedFetcher({ "http://l/x": [0], "http://r/x": [0] }),
      });
      // 0 silently disabling all probes would be a footgun; we treat
      // it as the default (=1) and report cleanly.
      expect(report.matches[0].left.perfStats).toBeUndefined();
      expect(report.matches[0].left.durationMs).toBeDefined();
    });

    it("falls back to durationMs when perfStats absent (single-sample with percentile set)", async () => {
      // Setting perfPercentile without perfSamples>1 shouldn't break
      // anything — the classifier just falls back to the single-sample
      // durationMs. Validates the contract robustness.
      const report = await runParity({
        left: "http://l",
        right: "http://r",
        paths: ["x"],
        perfSamples: 1,
        perfPercentile: "p99",
        perfDeltaMs: 80,
        fetcher: makeQueuedTimedFetcher({ "http://l/x": [0], "http://r/x": [200] }),
      });
      expect(report.mismatches[0]?.kinds).toContain("perf");
    });
  });

  it("flags 3xx → 200 status mismatch (not redirect mismatch)", async () => {
    // Same status family check guards against false-positive redirects:
    // 301 vs 200 should be reported as a status mismatch, not a redirect mismatch.
    const fetcher = makeFetcher({
      "http://left/x": () =>
        new Response("", { status: 301, headers: { location: "/dest" } }),
      "http://right/x": () => new Response("", { status: 200 }),
    });
    const report = await runParity({
      left: "http://left",
      right: "http://right",
      paths: ["x"],
      fetcher,
    });
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].kinds[0]).toBe("status");
  });
});
