import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { aiDriver } from "./drivers/ai-driver.js";
import {
  isObstructed,
  type Driver,
  type DriverCandidate,
  type DriverProvider,
  type DriverProviderCandidate,
  type DriverStep,
} from "./drivers/types.js";

/**
 * The geometry has to survive the trip from the page to the driver, and it
 * has to be right about a click nobody can see failing.
 *
 * The fixture is the real bug this is for: a tip card whose backdrop stays
 * in the layout after the card is styled away, so a transparent
 * full-screen layer swallows every click. It renders nothing, logs
 * nothing, and leaves the page text unchanged — three of the four ways a
 * crawl might notice. The fourth is the geometry.
 *
 * Measured on a gated-checkout SPA with this same bug: of 13 steps that
 * changed nothing, `isObstructed` flagged 12, and all 12 were real dead
 * clicks. The model's own confidence on those picks was 0.99 or above,
 * which is the point — it had nothing to be unsure about.
 *
 * A unit test cannot reach this. `getBoundingClientRect`,
 * `elementFromPoint` and `getComputedStyle` are the whole mechanism, so a
 * hand-built `DriverCandidate` would only be testing the assertion.
 */
const BACKDROP = `<!doctype html><title>covered</title><body>
  <style>
    /* Sits above everything and is completely invisible. */
    #consent-backdrop { position: fixed; inset: 0; z-index: 50; background: transparent; }
    #consent-card { position: fixed; right: 1rem; bottom: 1rem; z-index: 51; }
    #untouchable { pointer-events: none; }
    #far-below { position: absolute; top: 4000px; }
  </style>
  <main>
    <button id="buy">Buy a widget</button>
    <button id="untouchable">Not clickable</button>
    <button id="far-below">Below the fold</button>
  </main>
  <div id="consent-backdrop"></div>
  <div id="consent-card"><button id="accept">Accept cookies</button></div>
</body>`;

/** Records the candidate list of the first step and then stops. */
function capturingDriver(sink: DriverCandidate[][]): Driver {
  return {
    name: "capture",
    async selectAction(step: DriverStep) {
      sink.push(step.candidates.map((c) => ({ ...c })));
      return { kind: "skip" };
    },
  };
}

describe("a driver is told what will receive its click", () => {
  let server: http.Server;
  const seen: DriverCandidate[][] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(BACKDROP);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));

    await new ChaosCrawler({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      maxPages: 1,
      maxActionsPerPage: 1,
      headless: true,
      timeout: 5000,
      logLevel: "silent",
      driver: capturingDriver(seen),
    }).start();
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  /** The candidates of the first step, by the element they describe. */
  const byName = (name: string): DriverCandidate | undefined =>
    (seen[0] ?? []).find((c) => c.description.includes(name));

  it("measures a box for every real target", () => {
    expect(seen.length).toBeGreaterThan(0);
    const buy = byName("Buy a widget");
    expect(buy?.bbox).toBeDefined();
    expect(buy!.bbox!.width).toBeGreaterThan(0);
  });

  it("names the invisible backdrop as the thing taking the click", () => {
    const buy = byName("Buy a widget")!;
    // The whole bug in one assertion: the button is visible, enabled and
    // reported as covered by a div that renders nothing.
    expect(buy.coveredBy).toContain("consent-backdrop");
    expect(isObstructed(buy)).toBe(true);
  });

  it("leaves the control that sits above the backdrop alone", () => {
    const accept = byName("Accept cookies")!;
    expect(accept.coveredBy).toBeUndefined();
    expect(isObstructed(accept)).toBe(false);
  });

  it("flags pointer-events: none as inert", () => {
    // The one case `coveredBy` cannot express on its own: with nothing
    // but ancestors behind it, the hit test returns an element this file
    // deliberately ignores, so `inert` is what is left to report.
    expect(byName("Not clickable")!.inert).toBe(true);
    expect(byName("Buy a widget")!.inert).toBe(false);
  });

  it("does not claim to know about a target below the fold", () => {
    // 4000px down, so no hit test ran. Playwright would scroll to it and
    // click it happily, so calling it obstructed would be wrong.
    const below = byName("Below the fold")!;
    expect(below.inViewport).toBe(false);
    expect(below.coveredBy).toBeUndefined();
    expect(isObstructed(below)).toBe(false);
  });

  it("leaves the scroll target without geometry", () => {
    const scroll = (seen[0] ?? []).find((c) => c.type === "scroll");
    expect(scroll).toBeDefined();
    expect(scroll!.bbox).toBeUndefined();
    expect(isObstructed(scroll!)).toBe(false);
  });
});

/**
 * And it has to survive the rest of the trip — to the model.
 *
 * The same page, reached through `aiDriver` rather than a hand-written
 * driver, because that is the seam a model actually sits behind. A
 * provider that is told `button "Buy a widget"` and nothing else has no
 * way to know the click is going into a backdrop, and the run above is
 * what that costs: 12 dead clicks the model reported 0.99 on.
 */
describe("a provider is told what will receive its click", () => {
  let server: http.Server;
  const seen: DriverProviderCandidate[][] = [];
  const screenshotShapes: string[] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(BACKDROP);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));

    const recording: DriverProvider = {
      name: "recording",
      async selectAction(input) {
        seen.push(input.candidates.map((c) => ({ ...c })));
        screenshotShapes.push(typeof input.screenshot);
        // Stand down: this test is about what arrived, not what it picks.
        return null;
      },
    };

    await new ChaosCrawler({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      maxPages: 1,
      maxActionsPerPage: 1,
      headless: true,
      timeout: 5000,
      logLevel: "silent",
      driver: aiDriver({ provider: recording }),
    }).start();
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  const byName = (name: string): DriverProviderCandidate | undefined =>
    (seen[0] ?? []).find((c) => c.description.includes(name));

  it("hands the provider the hit-test result", () => {
    expect(seen.length).toBeGreaterThan(0);
    const buy = byName("Buy a widget")!;
    expect(buy.coveredBy).toContain("consent-backdrop");
    expect(isObstructed(buy)).toBe(true);
    expect(isObstructed(byName("Accept cookies")!)).toBe(false);
  });

  it("hands the provider the target type", () => {
    // Whether a candidate takes a click or a value, which decides what
    // there even is to answer about it.
    expect(byName("Buy a widget")!.type).toBe("button");
    expect((seen[0] ?? []).some((c) => c.type === "scroll")).toBe(true);
  });

  it("keeps the selector on this side of the seam", () => {
    for (const c of seen[0] ?? []) expect(c).not.toHaveProperty("selector");
  });

  it("hands the provider a capture it may decline, not bytes", () => {
    // The whole crawl above ran a provider that never looked at a pixel,
    // and nothing captured. What reached it was a thunk.
    expect(screenshotShapes.length).toBeGreaterThan(0);
    for (const shape of screenshotShapes) expect(shape).toBe("function");
  });
});
