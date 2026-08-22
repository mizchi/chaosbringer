import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chaos } from "./chaos.js";
import { validateOptions } from "./crawler.js";

/**
 * `initScripts` exists because "before the page's own scripts" is not a nicety
 * — it is the difference between an observer that measures and one that reports
 * zero. The model runner's timer watch used to be installed from an `afterLoad`
 * invariant, and every timer the page scheduled while loading was invisible to
 * it; the run then said `pendingAsync: { timers: 0 }`, which reads as a fact
 * about the page rather than as the absence of a measurement.
 *
 * So what has to be pinned is the ordering, not merely that the script ran.
 */
describe("initScripts run before the page's own scripts", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      // The page reads the flag the init script sets and records the answer
      // where an invariant can see it. If the init script ran second, `saw` is
      // false and the flag is still set by the time anyone looks — which is why
      // asserting the flag alone would pass either way.
      res.end(`<!doctype html><title>i</title><body><script>
        window.__sawInitScript = window.__installedEarly === true;
      </script></body>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("is a real option, and a typo of it is caught", () => {
    expect(() => validateOptions({ baseUrl: base, initScripts: ["/* noop */"] })).not.toThrow();
    // The near-miss guard is the half of this that can actually fail: it only
    // suggests names it knows, so `initScript` resolving to `initScripts`
    // proves the option is in `KNOWN_OPTION_NAMES`. (The other half — an option
    // missing from that list — is a compile error from the `UnlistedOptionNames`
    // guard in `crawler.ts`, which no runtime test can observe.)
    expect(() => validateOptions({ baseUrl: base, initScript: [] } as never)).toThrow(
      /unknown option "initScript".*initScripts/s,
    );
  });

  it("evaluates before the page's inline script", async () => {
    let saw: unknown;
    await chaos({
      baseUrl: base,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      initScripts: ["window.__installedEarly = true;"],
      invariants: [
        {
          name: "read-order",
          when: "afterLoad",
          check: async ({ page }) => {
            saw = await page.evaluate("window.__sawInitScript");
            return true;
          },
        },
      ],
    });
    expect(saw).toBe(true);
  }, 60_000);

  it("runs nothing when none are given", async () => {
    let saw: unknown;
    await chaos({
      baseUrl: base,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      invariants: [
        {
          name: "read-order",
          when: "afterLoad",
          check: async ({ page }) => {
            saw = await page.evaluate("window.__sawInitScript");
            return true;
          },
        },
      ],
    });
    // The control case: without the option the page sees no flag, so the test
    // above is measuring the option and not the fixture.
    expect(saw).toBe(false);
  }, 60_000);
});
