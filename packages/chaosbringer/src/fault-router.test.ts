import http from "node:http";
import type { AddressInfo } from "node:net";
import { faults } from "@mizchi/playwright-faults";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyFault, applyFaultRules, applyFaults } from "./fault-router.js";

/**
 * `applyFaultRules` exists because every other way into the fault layers runs
 * a crawl. A regression test for one incident wants the opposite: one page,
 * one scripted click, one rule that fires on a known request, and a count
 * afterwards proving it fired.
 */
describe("applyFaultRules on a page you drive yourself", () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;
  let posts = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/api/save") {
        if (req.method === "POST") posts++;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"id":"note-1"}');
        return;
      }
      if (path === "/api/slow") return; // never answered by the origin either
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(`<!doctype html><title>app</title><body>
<button id="save">Save</button><div id="state">idle</div>
<script>
  const state = document.getElementById("state");
  document.getElementById("save").onclick = async () => {
    state.textContent = "saving";
    try {
      const r = await fetch("/api/save", { method: "POST" });
      // Read the body, because that is where a reject-body fault lands: the
      // request succeeded and the reply is what the client cannot have.
      const body = await r.json();
      state.textContent = r.ok && body ? "saved" : "error " + r.status;
    } catch {
      state.textContent = "threw";
    }
  };
  window.hangOnce = () => {
    state.textContent = "waiting";
    fetch("/api/slow").then(() => { state.textContent = "answered"; },
                           () => { state.textContent = "gave up"; });
  };
  window.hangBounded = (ms) => {
    state.textContent = "waiting";
    fetch("/api/slow", { signal: AbortSignal.timeout(ms) }).then(
      () => { state.textContent = "answered"; },
      (e) => { state.textContent = "bounded:" + e.name; });
  };
</script></body>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("fires on the request the app makes, and says so in the counters", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const session = await applyFaultRules(page, [
        faults.status(500, { name: "save-500", urlPattern: /\/api\/save$/, methods: ["POST"] }),
      ]);
      const before = posts;
      await page.click("#save");
      await expect.poll(() => page.textContent("#state")).toBe("error 500");
      // The counters are the guard against a test that passes for no reason:
      // a typo'd urlPattern gives `matched: 0`, and an app that shows an error
      // banner unconditionally would pass the DOM assertion alone.
      expect(session.stats()).toEqual([
        { rule: "save-500", matched: 1, injected: 1 },
      ]);
      // Fulfilled in the browser: the origin never saw it.
      expect(posts).toBe(before);
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("respects a schedule, so the retry can be the call that succeeds", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const session = await applyFaultRules(page, [
        faults.status(503, {
          name: "save-503",
          urlPattern: /\/api\/save$/,
          schedule: { decisions: ["inject", "pass"] },
        }),
      ]);
      await page.click("#save");
      await expect.poll(() => page.textContent("#state")).toBe("error 503");
      await page.click("#save");
      await expect.poll(() => page.textContent("#state")).toBe("saved");
      expect(session.stats()[0]).toEqual({ rule: "save-503", matched: 2, injected: 1 });
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("holds a hang open until you release it", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const session = await applyFaultRules(page, [
        faults.hang({ urlPattern: /\/api\/slow$/ }),
      ]);
      await page.evaluate("window.hangOnce()");
      await expect.poll(() => page.textContent("#state")).toBe("waiting");
      expect(session.heldRequests()).toBe(1);
      // Still waiting a beat later — this is the spinner-forever state, and
      // the point is that it is observable rather than a timeout.
      await new Promise((r) => setTimeout(r, 150));
      expect(await page.textContent("#state")).toBe("waiting");

      await session.release();
      // Releasing runs the app's `catch`, which is the other half of the
      // contract most spinner bugs get wrong.
      await expect.poll(() => page.textContent("#state")).toBe("gave up");
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does not put a hang beyond a caller that can cancel", async () => {
    // I wrote in the skill that the network `hang` "parks the request outside
    // the page's reach", contrasting it with `never-settle-fetch`, which
    // honours `init.signal`. That contrast is false, and it nearly cost a
    // reader the right layer: `AbortSignal.timeout` aborts the *fetch*, and the
    // browser cancels the request whether or not the route ever answers. Both
    // hang flavours leave an unbounded caller waiting and let a bounded one
    // out.
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const session = await applyFaultRules(page, [faults.hang({ urlPattern: /\/api\/slow$/ })]);
      await page.evaluate("window.hangBounded(250)");
      await expect.poll(() => page.textContent("#state"), { timeout: 5000 }).toBe(
        "bounded:TimeoutError",
      );
      // The request was still parked from the route's point of view — the
      // difference between the two faults is not reachability.
      expect(session.heldRequests()).toBe(1);
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("and the difference that is real: a hang makes a request, never-settle does not", async () => {
    // What actually separates them, and it is worth knowing which one you
    // want: `hang` is an HTTP request the origin can see (and the browser
    // reports as a failed request when it is aborted); `never-settle-fetch`
    // patches `fetch` in the page, so nothing is ever sent.
    const page = await browser.newPage();
    try {
      const netRequests: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/slow")) netRequests.push(r.url());
      });
      const session = await applyFaults(page, {
        runtime: [
          { name: "never", urlPattern: /\/api\/slow$/, action: { kind: "never-settle-fetch" } },
        ],
      });
      await page.goto(base + "/");
      await page.evaluate("window.hangBounded(250)");
      await expect.poll(() => page.textContent("#state"), { timeout: 5000 }).toBe(
        "bounded:TimeoutError",
      );
      expect(netRequests).toEqual([]);
      expect(await session.runtimeStats()).toEqual([{ rule: "never", matched: 1, fired: 1 }]);
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("never-settle-fetch rejects as TimeoutError under AbortSignal.timeout", async () => {
    // Stated as fact in the skill, so it needs to be a test rather than a
    // recollection: a `catch` branching on `err.name === "AbortError"` misses
    // this, and the app then looks broken when it is not.
    const page = await browser.newPage();
    try {
      const session = await applyFaults(page, {
        runtime: [
          { name: "never", urlPattern: /\/api\/slow$/, action: { kind: "never-settle-fetch" } },
        ],
      });
      await page.goto(base + "/");
      await page.evaluate("window.hangBounded(250)");
      await expect.poll(() => page.textContent("#state"), { timeout: 5000 }).toBe(
        "bounded:TimeoutError",
      );
      // An explicit abort still gives AbortError, which is the contrast that
      // makes the first half worth knowing.
      await page.evaluate(`(() => {
        const c = new AbortController();
        const s = document.getElementById("state");
        s.textContent = "waiting";
        fetch("/api/slow", { signal: c.signal }).then(
          () => { s.textContent = "answered"; },
          (e) => { s.textContent = "bounded:" + e.name; });
        c.abort();
      })()`);
      await expect.poll(() => page.textContent("#state"), { timeout: 5000 }).toBe(
        "bounded:AbortError",
      );
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("still reports what fired after dispose, and after the page is gone", async () => {
    // `firings()` reads counters out of the page, so calling it after teardown
    // used to return zeros — indistinguishable from "the fault never fired",
    // in the one call whose whole purpose is to stop silent no-ops. Somebody
    // hit this ordering trap.
    const page = await browser.newPage();
    const session = await applyFaults(page, {
      runtime: [
        { name: "save-unreadable", urlPattern: /\/api\/save$/, action: { kind: "reject-body" } },
      ],
    });
    await page.goto(base + "/");
    await page.click("#save");
    await expect.poll(() => page.textContent("#state")).toBe("threw");

    await session.dispose();
    expect(await session.firings()).toMatchObject([{ name: "save-unreadable", fired: 1 }]);
    await page.close();
    // And after the page itself is gone.
    expect(await session.firings()).toMatchObject([{ name: "save-unreadable", fired: 1 }]);
  }, 60_000);

  it("but reports zero when there is genuinely nothing to report", async () => {
    // The snapshot must not become a way to invent numbers: a fault applied
    // after the navigation that would have installed it really did match
    // nothing, and that has to keep reading as zero.
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const session = await applyFaults(page, {
        runtime: [{ name: "too-late", urlPattern: /\/api\/save$/, action: { kind: "reject-fetch" } }],
      });
      await session.dispose();
      expect(await session.firings()).toMatchObject([{ name: "too-late", matched: 0, fired: 0 }]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("hands the page back to the real origin on dispose", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const session = await applyFaultRules(page, [
        faults.status(500, { urlPattern: /\/api\/save$/ }),
      ]);
      await session.dispose();
      const before = posts;
      await page.click("#save");
      await expect.poll(() => page.textContent("#state")).toBe("saved");
      expect(posts).toBe(before + 1);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("applies a runtime fault to a page you drive, so rejectBody composes with this", async () => {
    // The case that did not compose: a double-write regression needs the
    // server to have *committed* — so a route-level fault is the wrong tool
    // and `faults.rejectBody` (runtime) is the right one — applied to a page
    // the caller drives, which only the network layer could do.
    const page = await browser.newPage();
    try {
      const session = await applyFaults(page, {
        runtime: [
          {
            name: "save-body-unreadable",
            // Runtime faults match the string handed to `fetch()`, not a
            // resolved absolute URL.
            urlPattern: /\/api\/save$/,
            methods: ["POST"],
            action: { kind: "reject-body" },
            schedule: { decisions: ["inject"], afterEnd: "pass" },
          },
        ],
      });
      // Init script, so it lands on the *next* navigation.
      await page.goto(base + "/");
      const before = posts;
      await page.click("#save");
      await expect.poll(() => page.textContent("#state")).toBe("threw");
      // The real request went out and the server really saw it — which is the
      // whole reason to use this layer.
      expect(posts).toBe(before + 1);

      const runtime = await session.runtimeStats();
      expect(runtime).toEqual([{ rule: "save-body-unreadable", matched: 1, fired: 1 }]);
      // And in the one vocabulary, so a caller does not have to know that this
      // layer says `fired` where the other says `injected`.
      const firings = await session.firings();
      expect(firings).toEqual([
        { name: "save-body-unreadable", layer: "runtime", matched: 1, fired: 1, suppressed: 0, errored: 0 },
      ]);
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reports matched: 0 for a runtime fault applied after the navigation", async () => {
    // An init script installs on navigation. Applying one to a loaded page and
    // getting silence is the failure mode the library exists to remove, so the
    // counters have to say so out loud.
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const session = await applyFaults(page, {
        runtime: [
          { name: "too-late", urlPattern: /\/api\/save$/, action: { kind: "reject-fetch" } },
        ],
      });
      await page.click("#save");
      await expect.poll(() => page.textContent("#state")).toBe("saved");
      expect(await session.runtimeStats()).toEqual([
        { rule: "too-late", matched: 0, fired: 0 },
      ]);
      await session.dispose();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("refuses a fault handed to the wrong layer, and says where it goes", async () => {
    // The library's own recipe for a retry-double-write is `faults.rejectBody`,
    // a *runtime* fault — so handing it to `network:` is the mistake a reader
    // following the docs makes, and it used to reach the route handler and die
    // with "Cannot read properties of undefined (reading 'kind')".
    const page = await browser.newPage();
    try {
      await expect(
        applyFaultRules(page, [faults.rejectBody({ name: "body", urlPattern: /\/api\/save$/ })] as never),
      ).rejects.toThrow(/is a RuntimeFault.*runtime: \[/s);
      await expect(
        applyFaults(page, {
          runtime: [faults.status(500, { name: "five", urlPattern: /\/api\/save$/ })] as never,
        }),
      ).rejects.toThrow(/is a network FaultRule.*network: \[/s);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("refuses a rule whose firing policy is ambiguous, at the call site", async () => {
    const page = await browser.newPage();
    try {
      await expect(
        applyFaultRules(page, [
          {
            name: "both",
            urlPattern: /\/api\/save$/,
            fault: { kind: "abort" },
            probability: 0.5,
            schedule: { decisions: ["inject"] },
          },
        ]),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("a fault kind the library does not know", () => {
  it("throws instead of parking the request forever", async () => {
    // Before `hang` existed, falling off `applyFault`'s switch was obviously a
    // bug: nothing responded, so the request hung and somebody noticed. Now
    // that "park it deliberately" is a real fault, a typo'd `kind` produced the
    // same symptom — with no entry in the held-route registry, so nothing
    // drained it and nothing counted it. A config error that presents as
    // intent is the worst kind, so it is now loud.
    const route = {
      abort: async () => {},
      fulfill: async () => {},
      fallback: async () => {},
    } as unknown as import("playwright").Route;
    await expect(
      applyFault(route, { kind: "statsu", status: 500 } as never),
    ).rejects.toThrow(/unknown fault kind "statsu"/);
  });

  it("still realises each kind it does know", async () => {
    // The guard above must not be satisfiable by throwing for everything.
    const calls: string[] = [];
    const route = {
      abort: async () => void calls.push("abort"),
      fulfill: async () => void calls.push("fulfill"),
      fallback: async () => void calls.push("fallback"),
    } as unknown as import("playwright").Route;
    await applyFault(route, { kind: "abort" });
    await applyFault(route, { kind: "status", status: 500 });
    await applyFault(route, { kind: "delay", ms: 1 });
    await applyFault(route, { kind: "hang" }, () => calls.push("held"));
    expect(calls).toEqual(["abort", "fulfill", "fallback", "held"]);
  });
});
