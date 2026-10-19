/**
 * A journey `drive` recorded on one server, replayed with a base URL that
 * names another. Each replay entry point (verify, the load bridge with and
 * without a `requires` chain, `recipeDriver`, repair) has to reach the
 * second server and leave the first alone; pointed at a port nobody
 * listens on, verify and load have to fail. They all used to replay on the
 * recording server and report success for a host they never reached.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newIsolatedPage } from "../browser-session.js";
import { planDecider } from "../drive/deciders.js";
import { drive } from "../drive/drive.js";
import type { DriverStep } from "../drivers/types.js";
import { weightedRandomDriver } from "../drivers/weighted-random.js";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";
import { scenarioLoadFromStore } from "./load-bridge.js";
import { recipeDriver } from "./recipe-driver.js";
import { repairRecipe } from "./repair.js";
import { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { verifyAndPromote } from "./verify.js";

const LOGIN = `<!doctype html><title>Log in</title><main><h1>Log in</h1>
<form onsubmit="event.preventDefault(); location.href = '/auth-thanks?via=login'">
  <label>Username <input name="username"></label>
  <button>Sign in</button>
</form></main>`;
const THANKS = `<!doctype html><title>Welcome</title><main><h1>Welcome</h1></main>`;

function app(hits: string[]): http.RequestListener {
  return (req, res) => {
    const path = req.url ?? "/";
    if (path !== "/favicon.ico") hits.push(path);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(path.startsWith("/auth-thanks") ? THANKS : LOGIN);
  };
}

describe("a recipe replayed on another base URL", () => {
  let recorded: TestServer;
  let other: TestServer;
  const recordedHits: string[] = [];
  const otherHits: string[] = [];
  let browser: Browser;
  let login: ActionRecipe;
  /** A server that was closed: what verify and load meet when staging is down. */
  let unreachable: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    recorded = await startTestServer(app(recordedHits));
    other = await startTestServer(app(otherHits));
    const closed = await startTestServer(app([]));
    unreachable = closed.url;
    await closed.close();
    browser = await chromium.launch();
    const result = await drive({
      url: `${recorded.url}/login`,
      goal: "log in",
      decider: planDecider([{ fill: 'textbox "Username"', value: "admin" }, { click: 'button "Sign in"' }]),
      until: { urlIncludes: "/auth-thanks" },
      recipeName: "site/login",
      browser,
    });
    expect(result.status).toBe("reached");
    if (!result.recipe) throw new Error(`drive recorded no recipe: ${result.recipeSkipped}`);
    login = result.recipe;
    expect(login.steps[0]).toEqual({ kind: "navigate", url: `${recorded.url}/login` });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await recorded?.close();
    await other?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function storeWith(...recipes: ActionRecipe[]): RecipeStore {
    const dir = mkdtempSync(join(tmpdir(), "rebase-e2e-"));
    dirs.push(dir);
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    for (const r of recipes) store.upsert(r);
    return store;
  }

  /** The store as the next run, or a teammate, reads it: from disk. */
  function reread(store: RecipeStore): RecipeStore {
    return new RecipeStore({ localDir: store.writeDir ?? false, globalDir: false, silent: true });
  }

  const setupPage = async () => {
    const { page, close } = await newIsolatedPage(browser);
    return { page, cleanup: close };
  };

  /** Runs `fn`, and fails if the recording server saw a request meanwhile. */
  async function offTheRecordedServer<T>(fn: () => Promise<T>): Promise<T> {
    const before = recordedHits.length;
    const out = await fn();
    expect(recordedHits.slice(before)).toEqual([]);
    return out;
  }

  it("verify replays on the base URL's server and promotes there", async () => {
    const store = storeWith(login);
    otherHits.length = 0;
    const result = await offTheRecordedServer(() =>
      verifyAndPromote(store, login, { runs: 1, baseUrl: `${other.url}/`, setupPage }),
    );
    expect(result).toMatchObject({ promoted: true, successRate: 1 });
    expect(otherHits).toEqual(["/login", "/auth-thanks?via=login"]);
  }, 60_000);

  it("verify fails, and does not promote, against a base URL nobody answers", async () => {
    const store = storeWith(login);
    const result = await offTheRecordedServer(() =>
      verifyAndPromote(store, login, { runs: 1, baseUrl: unreachable, setupPage }),
    );
    expect(result.promoted).toBe(false);
    expect(result.outcomes[0]?.reason).toContain(`ERR_CONNECTION_REFUSED at ${unreachable}/login`);
  }, 60_000);

  it("verify leaves a verified recipe as it was when the base URL does not answer", async () => {
    // A host that is down says nothing about the recipe. Verify used to
    // count each run as a failure and demote the recipe on disk.
    const verified: ActionRecipe = {
      ...login,
      status: "verified",
      stats: { ...login.stats, successCount: 5, failCount: 0 },
    };
    const store = storeWith(verified);
    const before = store.get(login.name);
    const result = await verifyAndPromote(store, verified, { runs: 3, baseUrl: unreachable, setupPage });
    expect(result).toMatchObject({ promoted: false, demoted: false });
    expect(result.unreachable).toBe(`net::ERR_CONNECTION_REFUSED at ${unreachable}/login`);
    // It stopped at the first run that could not connect.
    expect(result.outcomes).toHaveLength(1);
    expect(reread(store).get(login.name)).toEqual(before);
  }, 60_000);

  it("verify still counts a replay the site answered and failed", async () => {
    const broken: ActionRecipe = {
      ...login,
      name: "site/login-gone",
      steps: [...login.steps.slice(0, 1), { kind: "click", selector: "#no-such-button" }],
      status: "verified",
    };
    const store = storeWith(broken);
    const result = await verifyAndPromote(store, broken, { runs: 1, baseUrl: other.url, setupPage });
    expect(result).toMatchObject({ promoted: false, demoted: true });
    expect(result.unreachable).toBeUndefined();
    expect(store.get(broken.name)).toMatchObject({ status: "demoted", stats: { failCount: 1 } });
  }, 60_000);

  it("load replays every recipe of a requires chain on the base URL's server", async () => {
    const thanks: ActionRecipe = {
      ...login,
      name: "site/thanks",
      steps: [{ kind: "navigate", url: `${recorded.url}/auth-thanks?again=1`, expectAfter: { hasSelector: "h1" } }],
      requires: ["site/login"],
    };
    const store = storeWith({ ...login, status: "verified" }, { ...thanks, status: "verified" });
    otherHits.length = 0;
    const { report } = await offTheRecordedServer(() =>
      scenarioLoadFromStore({
        baseUrl: other.url,
        store,
        workers: 1,
        duration: "30s",
        maxIterationsPerWorker: 2,
        thinkTime: { distribution: "none" },
        filter: (r) => r.name === "site/thanks",
      }),
    );
    expect(report.totals).toMatchObject({ iterations: 2, iterationFailures: 0 });
    expect(otherHits).toContain("/login");
    expect(otherHits).toContain("/auth-thanks?again=1");
  }, 60_000);

  it("load counts failures against a base URL nobody answers", async () => {
    const store = storeWith({ ...login, status: "verified" });
    const { report } = await offTheRecordedServer(() =>
      scenarioLoadFromStore({
        baseUrl: unreachable,
        store,
        workers: 1,
        duration: "30s",
        maxIterationsPerWorker: 1,
        thinkTime: { distribution: "none" },
      }),
    );
    expect(report.totals.iterationFailures).toBe(1);
  }, 60_000);

  it("load stops, says the base URL is unreachable, and leaves the store alone", async () => {
    // It used to fail for its whole duration: the replays demoted the recipe
    // on disk, then every iteration threw on an empty candidate list, tens of
    // thousands a second, until building the report overflowed the stack.
    const verified: ActionRecipe = {
      ...login,
      status: "verified",
      stats: { ...login.stats, successCount: 5, failCount: 0 },
    };
    const store = storeWith(verified);
    const before = store.get(login.name);
    const started = Date.now();
    const { report } = await scenarioLoadFromStore({
      baseUrl: unreachable,
      store,
      // The second worker is due 30s in: the stop has to end its ramp-up
      // wait too, or the report waits for it.
      workers: 2,
      rampUp: "30s",
      duration: "40s",
      thinkTime: { distribution: "none" },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(report.stopped).toMatchObject({
      cause: "unreachable",
      reason: `base URL unreachable: ${unreachable} (net::ERR_CONNECTION_REFUSED at ${unreachable}/login, 3 iterations in a row)`,
    });
    expect(report.totals).toMatchObject({ iterations: 3, iterationFailures: 3 });
    expect(reread(store).get(login.name)).toEqual(before);
  }, 60_000);

  it("recipeDriver replays on the server the crawl is on", async () => {
    const store = storeWith({ ...login, status: "verified" });
    const { page, close } = await newIsolatedPage(browser);
    try {
      await page.goto(`${other.url}/login`);
      const step = { url: `${other.url}/login`, currentUrl: `${other.url}/login`, page } as unknown as DriverStep;
      const pick = await recipeDriver({ store }).selectAction(step);
      expect(pick?.kind).toBe("custom");
      if (pick?.kind !== "custom") return;
      const action = await offTheRecordedServer(() => pick.perform(page));
      expect(action.success).toBe(true);
      expect(page.url()).toBe(`${other.url}/auth-thanks?via=login`);
    } finally {
      await close();
    }
  }, 60_000);

  it("recipeDriver leaves a recipe that starts on the matched page and goes to another site there", async () => {
    // A payment provider: the only absolute URL in the recipe, and not
    // the site it was recorded on, so not one to move onto the crawl's.
    const payHits: string[] = [];
    const pay = await startTestServer(app(payHits));
    const checkout: ActionRecipe = {
      ...login,
      name: "site/pay",
      preconditions: [{ urlPattern: "/login$" }],
      steps: [
        { kind: "fill", selector: "input[name=username]", value: "admin" },
        { kind: "navigate", url: `${pay.url}/auth-thanks?session=abc`, expectAfter: { hasSelector: "h1" } },
      ],
      status: "verified",
    };
    const store = storeWith(checkout);
    const { page, close } = await newIsolatedPage(browser);
    try {
      await page.goto(`${other.url}/login`);
      const step = { url: `${other.url}/login`, currentUrl: `${other.url}/login`, page } as unknown as DriverStep;
      const pick = await recipeDriver({ store }).selectAction(step);
      expect(pick?.kind).toBe("custom");
      if (pick?.kind !== "custom") return;
      otherHits.length = 0;
      expect(await pick.perform(page)).toMatchObject({ success: true });
      expect(page.url()).toBe(`${pay.url}/auth-thanks?session=abc`);
      expect(payHits).toEqual(["/auth-thanks?session=abc"]);
      expect(otherHits).toEqual([]);
    } finally {
      await close();
      await pay.close();
    }
  }, 60_000);

  it("repair replays on the base URL's server", async () => {
    const store = storeWith(login);
    otherHits.length = 0;
    const result = await offTheRecordedServer(() =>
      repairRecipe({ recipe: login, store, driver: weightedRandomDriver(), browser, baseUrl: other.url, seed: 1 }),
    );
    // Nothing broke on that server either, so nothing to repair.
    expect(result).toMatchObject({ repaired: false, failedAt: login.steps.length });
    expect(otherHits).toContain("/auth-thanks?via=login");
  }, 60_000);

  it("repair stores the repaired version with the URLs it ran on", async () => {
    // The sign-in button lost its id; the goal is the welcome page.
    const broken: ActionRecipe = {
      ...login,
      name: "site/login-broken",
      steps: [
        { kind: "navigate", url: `${recorded.url}/login` },
        { kind: "click", selector: "#sign-in", expectAfter: { urlContains: "/auth-thanks" } },
      ],
      postconditions: [{ hasSelector: "text=Welcome" }],
    };
    const store = storeWith(broken);
    const result = await offTheRecordedServer(() =>
      repairRecipe({ recipe: broken, store, driver: weightedRandomDriver(), browser, baseUrl: other.url, seed: 1 }),
    );
    expect(result).toMatchObject({ repaired: true, failedAt: 1 });
    expect(result.recipe?.steps[0]).toEqual({ kind: "navigate", url: `${other.url}/login` });
    expect(store.get("site/login-broken")?.steps[0]).toEqual({ kind: "navigate", url: `${other.url}/login` });
  }, 60_000);
});
