/**
 * `chaosbringer load` and `recipes verify` through the CLI, pointed at what
 * a typo or an outage gives them: a base URL nobody answers, a store with
 * nothing to replay, a status filter. `load` used to loop tens of thousands
 * of times a second, demote the store's verified recipes on disk, and crash
 * building its report; `verify` demoted the recipe it was asked to check.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";
import type { ActionRecipe, RecipeStatus } from "./types.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const FILE = "site__about.json";

/** Async, not spawnSync: the test server answers from this process's event loop. */
function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: PACKAGE_DIR, timeout: 90_000 },
      (err, stdout, stderr) => {
        const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ status, stdout, stderr, ms: Date.now() - started });
      },
    );
  });
}

describe("load and recipes verify on the command line", () => {
  let server: TestServer;
  /** A server that was closed: what a run meets when staging is down. */
  let down: string;
  let dir: string;
  let stores = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "load-cli-e2e-"));
    server = await startTestServer((req, res) => {
      // The site answers: with a redirect to a host that is down (a payment
      // provider, an SSO page), and by resetting the connection (shedding load).
      if (req.url?.startsWith("/checkout")) {
        res.writeHead(302, { location: `${down}/pay` });
        res.end();
        return;
      }
      if (req.url?.startsWith("/reset")) {
        req.socket.resetAndDestroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>About</title><h1>About</h1>");
    });
    const closed = await startTestServer(() => {});
    down = closed.url;
    await closed.close();
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A store directory holding one recipe for `origin`, with 5 recorded successes. */
  function storeWith(status: RecipeStatus, origin: string, steps?: ActionRecipe["steps"]): string {
    const store = join(dir, `store-${stores++}`);
    mkdirSync(store);
    const recipe: ActionRecipe = {
      name: "site/about",
      description: "",
      preconditions: [],
      steps: steps ?? [{ kind: "navigate", url: `${origin}/about`, expectAfter: { hasSelector: "h1" } }],
      postconditions: [],
      requires: [],
      stats: { successCount: 5, failCount: 0, avgDurationMs: 50, lastSuccessAt: null, lastFailAt: null, maxDurationMs: 80 },
      origin: "hand-written",
      status,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    writeFileSync(join(store, FILE), `${JSON.stringify(recipe, null, 2)}\n`);
    return store;
  }

  const recipeFile = (store: string) => readFileSync(join(store, FILE), "utf8");

  /** `storeWith`'s site/about, and shop/broken: /about, then `path`, which fails. */
  function storeWithBroken(path: string): string {
    const store = storeWith("verified", server.url);
    const broken: ActionRecipe = {
      ...(JSON.parse(recipeFile(store)) as ActionRecipe),
      name: "shop/broken",
      steps: [
        { kind: "navigate", url: `${server.url}/about` },
        { kind: "navigate", url: `${server.url}${path}`, expectAfter: { hasSelector: "h1" } },
      ],
    };
    writeFileSync(join(store, "shop__broken.json"), `${JSON.stringify(broken, null, 2)}\n`);
    return store;
  }
  const brokenStats = (store: string) =>
    (JSON.parse(readFileSync(join(store, "shop__broken.json"), "utf8")) as ActionRecipe).stats;

  it("load refuses a store with nothing to replay, before a browser starts", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const r = await cli(["load", "--base-url", server.url, "--dir", empty, "--duration", "30s"]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`load: no verified recipes in ${empty} — nothing to replay`);

    const store = storeWith("verified", server.url);
    const demoted = await cli(["load", "--base-url", server.url, "--dir", store, "--filter-status", "demoted"]);
    expect(demoted.status).toBe(2);
    expect(demoted.stderr.trim()).toBe(`load: no demoted recipes in ${store} — nothing to replay`);
  }, 60_000);

  it("load stops on a base URL nobody answers: exit 2, the report written, the store untouched", async () => {
    // Recording is on: the refused replays are what it leaves out.
    const store = storeWith("verified", down);
    const before = recipeFile(store);
    const output = join(dir, "down-report.json");
    const r = await cli([
      "load", "--base-url", down, "--dir", store, "--output", output,
      "--duration", "30s", "--workers", "2", "--think-time", "0-0", "--quiet",
    ]);
    expect(r.status).toBe(2);
    expect(r.ms).toBeLessThan(20_000);
    const last = r.stderr.trim().split("\n").at(-1);
    expect(last).toBe(
      `load: base URL unreachable: ${down} (net::ERR_CONNECTION_REFUSED at ${down}/about, 3 iterations in a row)`,
    );
    expect(existsSync(output)).toBe(true);
    const { report } = JSON.parse(readFileSync(output, "utf8"));
    expect(report.stopped).toMatchObject({ cause: "unreachable" });
    expect(recipeFile(store)).toBe(before);
  }, 60_000);

  const live = (store: string, ...extra: string[]) =>
    cli([
      "load", "--base-url", server.url, "--dir", store,
      "--duration", "2s", "--workers", "1", "--think-time", "50-100", "--quiet", ...extra,
    ]);

  it("load --filter-status candidate --no-record replays the candidates, and leaves them as they were", async () => {
    // It used to pick from the verified recipes whatever the status, and
    // fail every iteration with "no verified recipes match filter".
    const store = storeWith("candidate", server.url);
    const before = recipeFile(store);
    const r = await live(store, "--filter-status", "candidate", "--no-record");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(recipeFile(store)).toBe(before);
  }, 60_000);

  it("load records each replay into the store by default, and stops when the candidates run out", async () => {
    // As 0.13.0 did and the cookbook says ("Stats land back on the store").
    const verified = storeWith("verified", server.url);
    expect((await live(verified)).status).toBe(0);
    expect((JSON.parse(recipeFile(verified)) as ActionRecipe).stats.successCount).toBeGreaterThan(5);

    const untouched = storeWith("verified", server.url);
    const before = recipeFile(untouched);
    expect((await live(untouched, "--no-record")).status).toBe(0);
    expect(recipeFile(untouched)).toBe(before);

    // The first recorded success promotes the only candidate (6 runs, all
    // passed), so the next iteration has nothing to pick.
    const candidate = storeWith("candidate", server.url);
    const r = await live(candidate, "--filter-status", "candidate");
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe("load: recipe-mix: no candidate recipes in the store any more — nothing left to replay");
    expect(JSON.parse(recipeFile(candidate))).toMatchObject({ status: "verified", stats: { successCount: 6 } });
  }, 60_000);

  it("load records a replay the site answered with a redirect to a dead host, or reset, and does not stop", async () => {
    // Both fail as `net::ERR_… at <base URL>/…`: the run used to read them as
    // the base URL being down, stop with exit 2 while it served /about, and
    // leave shop/broken verified at 5 successes after 10 failed replays.
    for (const path of ["/checkout", "/reset"]) {
      const store = storeWithBroken(path);
      const output = join(dir, `broken${path.slice(1)}.json`);
      const r = await live(store, "--output", output);
      expect(r.stderr).not.toContain("unreachable");
      expect(r.status).toBe(1);
      expect(JSON.parse(readFileSync(output, "utf8")).report.stopped).toBeUndefined();
      expect(brokenStats(store).failCount).toBeGreaterThan(0);
    }
  }, 90_000);

  it("recipes verify records a replay the site answered with a redirect to a dead host", async () => {
    const store = storeWithBroken("/checkout");
    const r = await cli(["recipes", "verify", "shop/broken", "--base-url", server.url, "--dir", store, "--quiet"]);
    expect(r.stderr).not.toContain("unreachable");
    expect(r.status).toBe(1);
    expect(brokenStats(store)).toMatchObject({ successCount: 5, failCount: 5 });
  }, 60_000);

  it("recipes verify exits 2 on a base URL nobody answers, and leaves the recipe as it was", async () => {
    const navigates = storeWith("verified", down);
    // Starts on the page it matched on, so verify navigates to --base-url first.
    const clicks = storeWith("verified", down, [{ kind: "click", selector: "h1" }]);
    for (const store of [navigates, clicks]) {
      const before = recipeFile(store);
      const r = await cli(["recipes", "verify", "site/about", "--base-url", down, "--dir", store, "--quiet"]);
      expect(r.status).toBe(2);
      expect(r.stderr.trim().split("\n").at(-1)).toMatch(
        new RegExp(`^verify: base URL unreachable: ${down} \\(net::ERR_CONNECTION_REFUSED at ${down}/.*\\); site/about left as it was$`),
      );
      expect(recipeFile(store)).toBe(before);
    }
  }, 90_000);
});
