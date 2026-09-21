import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { ActionResult } from "./types.js";
import type { Driver, DriverPick, DriverStep } from "./drivers/types.js";

/**
 * Emptying one field is a state, not a value.
 *
 * The fixture is the bug that shape finds: the form validates on `input`
 * and caches the answer, so a field that is filled and then emptied
 * leaves `valid` stuck at true. Submit trusts the cache, the handler
 * dereferences the missing value, and the page throws.
 *
 * Reaching it needs the two steps in order — fill, then empty the same
 * field. `fillValueFor` only ever produces a non-empty string, so a
 * driver picking by index could do the first and never the second.
 */
const STALE_VALIDITY = `<!doctype html><title>checkout</title><body>
  <form id="pay" onsubmit="return false">
    <label for="coupon">Coupon</label>
    <input id="coupon" name="coupon" type="text" />
    <button id="apply" type="button">Apply coupon</button>
  </form>
  <p id="out"></p>
  <script>
    var valid = false;
    var coupon = document.getElementById("coupon");
    // The bug: validity is recomputed only when there is something to
    // read, so emptying the field never clears it.
    coupon.addEventListener("input", function () {
      if (coupon.value.length > 0) valid = true;
    });
    document.getElementById("apply").addEventListener("click", function () {
      if (!valid) {
        document.getElementById("out").textContent = "enter a coupon";
        return;
      }
      // Throws on an empty field: the cache said there was a value.
      document.getElementById("out").textContent =
        "applied " + coupon.value.match(/\\S+/)[0].toUpperCase();
    });
  </script>
</body>`;

/**
 * Fill the coupon field, empty the same field, then press Apply. Returns
 * `skip` afterwards so the crawl ends without further actions.
 */
function fillThenClearDriver(): Driver {
  let stage = 0;
  return {
    name: "fill-then-clear",
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      const coupon = step.candidates.find((c) => c.type === "input");
      const apply = step.candidates.find((c) => c.description.includes("Apply coupon"));
      if (!coupon || !apply) return { kind: "skip" };
      if (stage === 0) {
        stage = 1;
        return { kind: "select", index: coupon.index, reasoning: "fill it" };
      }
      if (stage === 1) {
        stage = 2;
        return { kind: "select", index: coupon.index, operation: "clear", reasoning: "empty it" };
      }
      if (stage === 2) {
        stage = 3;
        return { kind: "select", index: apply.index, reasoning: "submit on a stale cache" };
      }
      return { kind: "skip" };
    },
  };
}

/** Asks to clear a button, which `clear()` would throw on. */
function clearsAButtonDriver(): Driver {
  let asked = 0;
  return {
    name: "clears-a-button",
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      const apply = step.candidates.find((c) => c.description.includes("Apply coupon"));
      if (!apply || asked > 0) return { kind: "skip" };
      asked += 1;
      return { kind: "select", index: apply.index, operation: "clear" };
    },
  };
}

async function crawlWith(driver: Driver, port: number) {
  const crawler = new ChaosCrawler({
    baseUrl: `http://127.0.0.1:${port}`,
    maxPages: 1,
    maxActionsPerPage: 4,
    headless: true,
    timeout: 5000,
    // `"error"` rather than the `"silent"` the neighbouring e2e files
    // pass: that one is not a `LogLevel` and silences everything only
    // because the comparison against `undefined` is always false. This
    // suite deliberately triggers a warn, and "error" suppresses it
    // without leaning on that.
    logLevel: "error",
    driver,
  });
  return crawler.start();
}

describe("a driver can empty a field it picked", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(STALE_VALIDITY);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("records the clear apart from the fill", async () => {
    const report = await crawlWith(fillThenClearDriver(), port);
    const types = report.actions.map((a: ActionResult) => a.type);
    expect(types).toContain("input");
    expect(types).toContain("clear");
    // Order matters for the bug: the field has to hold something first.
    expect(types.indexOf("input")).toBeLessThan(types.indexOf("clear"));
    const cleared = report.actions.find((a: ActionResult) => a.type === "clear")!;
    expect(cleared.success).toBe(true);
    expect(cleared.selector).toBeTruthy();
  }, 60_000);

  it("finds the bug that only the empty state reaches", async () => {
    const report = await crawlWith(fillThenClearDriver(), port);
    const errors = report.pages[0]!.errors ?? [];
    const thrown = errors.filter(
      (e) => e.type === "exception" || e.type === "unhandled-rejection" || e.type === "console",
    );
    expect(thrown.length).toBeGreaterThan(0);
    expect(JSON.stringify(thrown)).toMatch(/null|undefined|match/i);
  }, 60_000);

  it("leaves the page alone when the same steps never empty the field", async () => {
    // The control: filling twice and submitting is the same three steps
    // with the clear replaced by a fill, and the cache is then telling
    // the truth. Without this arm the test above only says "a crawl
    // found an error", not "the empty state is what found it".
    let stage = 0;
    const fillTwice: Driver = {
      name: "fill-twice",
      async selectAction(step) {
        const coupon = step.candidates.find((c) => c.type === "input");
        const apply = step.candidates.find((c) => c.description.includes("Apply coupon"));
        if (!coupon || !apply) return { kind: "skip" };
        if (stage < 2) {
          stage += 1;
          return { kind: "select", index: coupon.index };
        }
        if (stage === 2) {
          stage = 3;
          return { kind: "select", index: apply.index };
        }
        return { kind: "skip" };
      },
    };
    const report = await crawlWith(fillTwice, port);
    const page = report.pages[0]!;
    expect(report.actions.map((a: ActionResult) => a.type)).not.toContain("clear");
    const thrown = (page.errors ?? []).filter(
      (e) => e.type === "exception" || e.type === "unhandled-rejection" || e.type === "console",
    );
    expect(thrown).toHaveLength(0);
  }, 60_000);

  it("refuses the operation on a target that cannot take it", async () => {
    // `clear()` on a button throws, and a thrown action is recorded
    // against the page under test. The pick is refused instead, so the
    // step is not spent and nothing is blamed on the page.
    const report = await crawlWith(clearsAButtonDriver(), port);
    expect(report.actions.map((a: ActionResult) => a.type)).not.toContain("clear");
    const failures = report.actions.filter((a: ActionResult) => !a.success);
    expect(failures).toHaveLength(0);
  }, 60_000);
});
