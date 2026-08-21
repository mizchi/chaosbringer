import http from "node:http";
import type { AddressInfo } from "node:net";
import { faults } from "@mizchi/playwright-faults";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyFaultRules } from "./fault-router.js";

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
      state.textContent = r.ok ? "saved" : "error " + r.status;
    } catch {
      state.textContent = "threw";
    }
  };
  window.hangOnce = () => {
    state.textContent = "waiting";
    fetch("/api/slow").then(() => { state.textContent = "answered"; },
                           () => { state.textContent = "gave up"; });
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
