import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { ActionResult } from "./types.js";
import type { Driver, DriverCandidate, DriverStep } from "./drivers/types.js";

/**
 * A dropdown has to survive the whole trip: scraped as a candidate,
 * carrying the value that will be set, performed with `selectOption`,
 * recorded with the value, and replayable from the record.
 *
 * A unit test cannot reach the first or the last of those. The scrape
 * runs in the page (`select.options` is the whole mechanism) and the
 * execution is a Playwright call, so a hand-built `RawActionTarget`
 * would only be testing the fixture.
 *
 * The page reports its own state, so "the dropdown was set" is read off
 * the app rather than inferred from the action record.
 */
const DROPDOWN = `<!doctype html><title>delivery</title><body>
  <main>
    <label for="shipping">Shipping method</label>
    <select id="shipping" name="shipping">
      <option value="">Choose…</option>
      <option value="standard" selected>Standard (5 days)</option>
      <option value="express">Express (next day)</option>
      <option value="courier" disabled>Courier (unavailable)</option>
    </select>
    <label for="size">Size</label>
    <select id="size" name="size">
      <option value="m" selected>Medium</option>
    </select>
    <button type="button" id="noop">Do nothing</button>
  </main>
  <p id="out">shipping=standard</p>
  <script>
    document.getElementById("shipping").addEventListener("change", function (e) {
      document.getElementById("out").textContent = "shipping=" + e.target.value;
    });
  </script>
</body>`;

function capturing(sink: { candidates: DriverCandidate[][] }): Driver {
  return {
    name: "capture",
    async selectAction(step: DriverStep) {
      sink.candidates.push(step.candidates.map((c) => ({ ...c })));
      const shipping = step.candidates.find(
        (c) => c.type === "select" && c.description.includes("shipping"),
      );
      return shipping ? { kind: "select", index: shipping.index } : { kind: "skip" };
    },
  };
}

describe("a dropdown is a candidate the crawler can set", () => {
  let server: http.Server;
  const sink: { candidates: DriverCandidate[][] } = { candidates: [] };
  let report: Awaited<ReturnType<ChaosCrawler["start"]>>;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(DROPDOWN);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));

    report = await new ChaosCrawler({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      maxPages: 1,
      maxActionsPerPage: 1,
      headless: true,
      timeout: 5000,
      logLevel: "error",
      driver: capturing(sink),
    }).start();
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  const first = (): DriverCandidate[] => sink.candidates[0] ?? [];
  const byName = (name: string) => first().find((c) => c.description.includes(name));

  it("scrapes the dropdown at all", () => {
    // The gap this closes. `fill()` refuses a <select>, so it was never a
    // fill target; it has no `role` attribute and is not a button, so
    // nothing else reached it either.
    expect(first().length).toBeGreaterThan(0);
    expect(byName("shipping")?.type).toBe("select");
  });

  it("tells the driver which value the pick would set", () => {
    // An index alone does not say what will happen: picking a dropdown
    // asks for a value.
    expect(byName("shipping")?.selectValue).toBe("express");
  });

  it("offers neither the placeholder nor a disabled option", () => {
    // `""` would set the dropdown to nothing and read as progress;
    // Playwright refuses a disabled option outright.
    const values = first()
      .filter((c) => c.type === "select")
      .map((c) => c.selectValue);
    expect(values).not.toContain("");
    expect(values).not.toContain("courier");
  });

  it("offers no value for a dropdown already on its only option", () => {
    const size = byName("size");
    expect(size?.type).toBe("select");
    expect(size?.selectValue).toBeUndefined();
  });

  it("sets it, and the page agrees", () => {
    const selects = report.actions.filter((a: ActionResult) => a.type === "select");
    expect(selects).toHaveLength(1);
    expect(selects[0]!.success).toBe(true);
    expect(selects[0]!.value).toBe("express");
  });

  it("records the value, which is what makes the step replayable", () => {
    // The one action whose value the trace can carry: an option value
    // came off the page rather than out of a generator, so a recipe needs
    // no `fillValueFor` hook to reproduce it.
    const set = report.actions.find((a: ActionResult) => a.type === "select")!;
    expect(set.selector).toBeTruthy();
    expect(set.value).toBe("express");
  });
});
