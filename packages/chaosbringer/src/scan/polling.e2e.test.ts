import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "./run.js";
import type { ScanFinding } from "./analyze.js";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";

/**
 * A page that polls keeps a request in every step: every 2 s action on a page
 * polling every 50 ms saw ~40 polls and read as a chatty action, and its load
 * read one waterfall wave per poll. The scan grades a step on what it fired
 * itself, so a polling page gets only `never-idle`, while a click that fires
 * 40 requests and a 6-step chain on the same page are still found, as on a
 * page that does not poll. A page with no timer whose every step refetches
 * the same endpoints is not polling: its findings stay.
 */
describe("runScan on a page that polls", () => {
  let server: TestServer;
  let base: string;
  let outDir: string;

  const POLL = `setInterval(() => fetch("/api/tick?" + Math.random()).then((r) => r.text()), 50);`;
  // A fixed URL: on base, a high duplicate-request on every step.
  const POLL_FIXED = `setInterval(() => fetch("/api/status").then((r) => r.text()), 50);`;
  const CHAT = `document.getElementById("chat").onclick = () => { for (let i = 0; i < 40; i++) fetch("/api/chat?q=" + i); };`;
  const CHAIN = `(async () => { for (const s of ["a", "b", "c", "d", "e", "f"]) await (await fetch("/api/chain/" + s)).text(); })();`;
  const page = (buttons: string, script: string) =>
    `<!doctype html><title>t</title><body>${buttons}<p id="o">x</p><script>${script}</script></body>`;
  const NOOP = `<button id="noop" onclick="document.getElementById('o').textContent='ok'">noop</button>`;
  const CHAT_BUTTON = `<button id="chat">chat</button>`;
  // No timer: the load and two refresh buttons each run the chain and fetch
  // /api/user twice at once (a double-fetch bug), and the load fires 10
  // queries at the one /graphql endpoint the chat button fires 40 at.
  const GQL = (n: number) =>
    `for (let i = 0; i < ${n}; i++) fetch("/graphql", { method: "POST", body: String(i) }).then((r) => r.text());`;
  const REFETCH = `const refresh = async () => { fetch("/api/user").then((r) => r.text()); fetch("/api/user").then((r) => r.text()); for (const s of ["a", "b", "c", "d", "e", "f"]) await (await fetch("/api/chain/" + s)).text(); };
refresh(); ${GQL(10)}
document.getElementById("refresh").onclick = refresh; document.getElementById("again").onclick = refresh;
document.getElementById("chat").onclick = () => { ${GQL(40)} };`;
  const REFETCH_BUTTONS = `<button id="refresh">refresh</button><button id="again">again</button>${CHAT_BUTTON}`;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path.startsWith("/api/chain/")) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(path);
        }, 40);
        return;
      }
      if (path === "/api/status" || path === "/api/user") {
        // A body that is transferred: duplicate-request skips a 0 KB response.
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(`{"v":"${"x".repeat(2000)}"}`);
        return;
      }
      if (path.startsWith("/api/") || path === "/graphql") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"ok":true}');
        return;
      }
      const html: Record<string, string> = {
        "/poll": page(NOOP, POLL_FIXED),
        "/quiet-refetch": page(REFETCH_BUTTONS, REFETCH),
        "/poll-chatty": page(NOOP + CHAT_BUTTON, POLL + CHAT + CHAIN),
        "/quiet-chatty": page(NOOP + CHAT_BUTTON, CHAT + CHAIN),
      };
      res.writeHead(html[path] ? 200 : 404, { "content-type": "text/html" });
      res.end(html[path] ?? "not found");
    });
    base = server.url;
    outDir = mkdtempSync(join(tmpdir(), "chaosbringer-scan-poll-"));
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  const scan = async (path: string, maxActionsPerPage = 4): Promise<Map<string, ScanFinding>> => {
    const result = await runScan({
      url: `${base}${path}`,
      maxPages: 1,
      maxActionsPerPage,
      seed: 3,
      outDir: join(outDir, path.slice(1)),
      coverage: false,
      chaos: false,
      crawler: { headless: true, actionWeights: { scroll: 0 } },
    });
    return new Map(result.analysis.findings.map((f) => [f.rule, f]));
  };

  it("finds never-idle, and nothing about requests, on a page that only polls", async () => {
    const byRule = await scan("/poll");
    expect(byRule.has("never-idle")).toBe(true);
    // Only the request rules: CPU rules (span-blocking) can still read a long
    // task of a busy test machine in the load, which is not this fix's subject.
    for (const rule of ["chatty-action", "request-waterfall", "duplicate-request"]) expect(byRule.has(rule)).toBe(false);
  }, 120_000);

  it("still finds a chatty click and a waterfall on a page that polls, at their own size", async () => {
    const byRule = await scan("/poll-chatty");
    const chatty = byRule.get("chatty-action");
    // Only the chat click: the noop clicks saw ~40 polls each.
    expect(chatty?.where).toEqual(['/poll-chatty :: click button:has-text("chat")']);
    expect(chatty?.severity).toBe("high");
    // 40 of its own, give or take a poll the rate before the click missed.
    expect(chatty?.evidence[0]).toMatch(/: 4[0-3] requests, .*\(plus \d+ to endpoints already polling before it\)$/);
    const waterfall = byRule.get("request-waterfall");
    expect(waterfall?.severity).toBe("high");
    // The document and the 6 chained fetches.
    expect(waterfall?.evidence[0]).toMatch(/: 7 serial request waves \(\d+ with the requests of endpoints polled around it\)$/);
    expect(byRule.has("never-idle")).toBe(true);
    expect(byRule.has("duplicate-request")).toBe(false);
  }, 120_000);

  it("grades the same click and chain the same on a page that does not poll", async () => {
    const byRule = await scan("/quiet-chatty");
    expect(byRule.get("chatty-action")?.severity).toBe("high");
    expect(byRule.get("chatty-action")?.evidence[0]).toMatch(/: 40 requests, [\d.]+ KB$/);
    expect(byRule.get("request-waterfall")?.evidence[0]).toMatch(/: 7 serial request waves$/);
  }, 120_000);

  it("keeps the findings of a page whose every step refetches the same endpoints", async () => {
    const byRule = await scan("/quiet-refetch", 6);
    expect(byRule.has("never-idle")).toBe(false);
    // The crawler's clicks, 200 to 450 ms apart, are not a poll's timer.
    expect(byRule.get("request-waterfall")?.evidence).toContain("/quiet-refetch :: load: 7 serial request waves");
    const dup = byRule.get("duplicate-request");
    expect(dup?.where).toContain("/quiet-refetch :: load");
    expect(dup?.where.length).toBeGreaterThan(1);
    // The load's 10 queries to /graphql are no poll to subtract from the chat click's 40.
    const chatty = byRule.get("chatty-action");
    expect(chatty?.severity).toBe("high");
    expect(chatty?.where).toContain('/quiet-refetch :: click button:has-text("chat")');
    for (const line of chatty?.evidence ?? []) expect(line).toMatch(/: 40 requests, [\d.]+ KB$/);
  }, 120_000);
});
