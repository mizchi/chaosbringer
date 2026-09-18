import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { Driver, DriverStep } from "./drivers/types.js";

/**
 * What a per-step driver is offered has to be what the page currently has.
 *
 * The driver loop used to map `targets` into candidates once, before the
 * step loop — so a driver got the controls of the screen the crawl arrived
 * at, for every step it took afterwards. On a multi-page site nothing
 * looked wrong, because leaving the screen meant a new page visit and a
 * fresh list. On anything that re-renders in place — hash or History
 * routing, a modal, a wizard — the second step onward chose from a list
 * the app had already thrown away, and the control the user is looking at
 * was not in it. The pick still resolved, against whatever element the
 * stale index happened to name.
 *
 * That is invisible from inside a driver: it gets a plausible list and
 * returns a plausible index. It is also invisible to a unit test with a
 * hand-built `DriverStep`, which is where every other driver test lives —
 * the list is stale precisely because the crawler built it, so only a real
 * crawl over a real re-rendering page can catch it. Hence a browser here.
 *
 * The fixture is the smallest thing with the property that matters: one
 * button, which replaces itself with a different button and moves the hash.
 * "Finish" does not exist when the crawl arrives, so a driver that is
 * offered it on step 2 can only have been given a re-collected list.
 */
const SPA = `<!doctype html><title>in-place rerender</title><body>
  <div id="view"><button id="go">Open step two</button></div>
  <script>
    // Delegated so the handler survives replacing the subtree.
    document.getElementById("view").addEventListener("click", (e) => {
      if (e.target.id !== "go") return;
      location.hash = "#/two";
      document.getElementById("view").innerHTML = '<button id="finish">Finish</button>';
    });
  </script>
</body>`;

interface SeenStep {
  candidates: string[];
  url: string;
  currentUrl: string;
}

/** Records what it was offered, then clicks the first button it sees. */
function recordingDriver(seen: SeenStep[]): Driver {
  return {
    name: "recorder",
    async selectAction(step: DriverStep) {
      seen.push({
        candidates: step.candidates.map((c) => c.description),
        url: step.url,
        currentUrl: step.currentUrl,
      });
      const button = step.candidates.find((c) => c.type === "button");
      return button ? { kind: "select", index: button.index } : { kind: "skip" };
    },
  };
}

describe("a per-step driver sees the page as it currently is", () => {
  let server: http.Server;
  let base: string;
  const seen: SeenStep[] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(SPA);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await new ChaosCrawler({
      baseUrl: base,
      maxPages: 1,
      maxActionsPerPage: 2,
      headless: true,
      timeout: 5000,
      logLevel: "silent",
      driver: recordingDriver(seen),
    }).start();
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("offers the control the previous step created", () => {
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]!.candidates.join(" | ")).toMatch(/Open step two/);
    // The whole bug in one line: before the fix this list was step 0's.
    expect(seen[1]!.candidates.join(" | ")).toMatch(/Finish/);
  });

  it("does not offer a control the page has not rendered yet", () => {
    expect(seen[0]!.candidates.join(" | ")).not.toMatch(/Finish/);
  });

  it("reports the live route in currentUrl and the page visit in url", () => {
    // `url` keys the page visit — budgets and onPageStart depend on it
    // holding still, so it stays where the crawl queued.
    expect(seen[1]!.url).not.toMatch(/#\/two/);
    expect(seen[1]!.currentUrl).toMatch(/#\/two/);
  });
});
