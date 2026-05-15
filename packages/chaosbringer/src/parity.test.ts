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
    expect(report.mismatches[0].kind).toBe("status");
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
    expect(report.mismatches[0].kind).toBe("redirect");
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
    expect(report.mismatches[0].kind).toBe("failure");
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
      expect(m.kind).toBe("body");
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
      expect(report.mismatches[0].kind).toBe("status");
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
      expect(m.kind).toBe("header");
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
      expect(report.mismatches[0].kind).toBe("header");
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
      expect(report.mismatches[0].kind).toBe("header");
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
      expect(report.mismatches[0].kind).toBe("exception");
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
      expect(report.mismatches[0].kind).toBe("exception");
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
      expect(report.mismatches[0].kind).toBe("status");
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
    expect(report.mismatches[0].kind).toBe("status");
  });
});
