/**
 * E2E for the snapshot fast-path in `runRecipeWithRequires`
 * (issue #89). Drives the fixture's `/login` to log in once, then
 * verifies a second fresh context skips the login chain link via
 * the captured storage state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  RecipeStore,
  runRecipeWithRequires,
  snapshotPath,
  type ActionRecipe,
} from "../../src/recipes/index.js";
import { emptyStats } from "../../src/recipes/types.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let browser: Browser;
let storeDir: string;

beforeAll(async () => {
  server = await startFixtureServer(0);
  browser = await chromium.launch({ headless: true });
  storeDir = mkdtempSync(join(tmpdir(), "snap-e2e-"));
}, 30000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await server.close();
  rmSync(storeDir, { recursive: true, force: true });
});

function mkRecipe(name: string, steps: ActionRecipe["steps"], requires: string[] = []): ActionRecipe {
  return {
    name,
    description: "",
    preconditions: [],
    steps,
    postconditions: [],
    requires,
    stats: emptyStats(),
    origin: "hand-written",
    status: "verified",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("runRecipeWithRequires snapshot fast-path", () => {
  it("captures storageState after login, injects it on the next fresh context", async () => {
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    // Prerequisite: log into the fixture as admin (sets cookie + localStorage).
    store.upsert(
      mkRecipe("auth/login", [
        { kind: "navigate", url: `${server.url}/login` },
        { kind: "fill", selector: "#username", value: "admin" },
        { kind: "fill", selector: "#password", value: "secret" },
        {
          kind: "click",
          selector: 'button[type="submit"]',
          expectAfter: { urlContains: "/auth-thanks", timeoutMs: 3000 },
        },
      ]),
    );
    // Dependent: just visits a page that requires the session.
    store.upsert(
      mkRecipe(
        "dashboard/visit",
        [{ kind: "navigate", url: `${server.url}/about` }],
        ["auth/login"],
      ),
    );

    // --- Run 1: fresh context. Snapshot does not exist yet, so the
    //     login chain link runs and is captured at the end.
    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const events1: string[] = [];
    try {
      await page1.goto(server.url);
      const r1 = await runRecipeWithRequires({
        page: page1,
        recipe: store.get("dashboard/visit")!,
        store,
        snapshot: true,
        onProgress: (ev) => {
          if (ev.kind === "skip") events1.push(`${ev.recipe}:skip:${ev.reason}`);
          else if (ev.kind === "complete") events1.push(`${ev.recipe}:${ev.result.ok ? "ok" : "fail"}`);
        },
      });
      expect(r1.ok).toBe(true);
      // No skip events on the first run.
      expect(events1).toEqual(["auth/login:ok", "dashboard/visit:ok"]);
    } finally {
      await ctx1.close();
    }
    // Snapshot should be on disk.
    expect(existsSync(snapshotPath(storeDir, "auth/login"))).toBe(true);

    // --- Run 2: brand-new context. Snapshot fast-path should fire.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    const events2: string[] = [];
    try {
      await page2.goto(server.url);
      const r2 = await runRecipeWithRequires({
        page: page2,
        recipe: store.get("dashboard/visit")!,
        store,
        snapshot: true,
        onProgress: (ev) => {
          if (ev.kind === "skip") events2.push(`${ev.recipe}:skip:${ev.reason}`);
          else if (ev.kind === "complete") events2.push(`${ev.recipe}:${ev.result.ok ? "ok" : "fail"}`);
        },
      });
      expect(r2.ok).toBe(true);
      // auth/login should be skipped via snapshot, dependent still runs.
      expect(events2).toEqual([
        "auth/login:skip:snapshot-applied",
        "dashboard/visit:ok",
      ]);
      // Cookies from the snapshot were applied to the new context.
      const cookies = await ctx2.cookies(server.url);
      const sessionCookie = cookies.find((c) => c.name === "session");
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie!.value).toBe("user-admin");
    } finally {
      await ctx2.close();
    }
  }, 60000);

  it("opts out by default (no snapshot when `snapshot` is unset)", async () => {
    const store = new RecipeStore({ localDir: mkdtempSync(join(tmpdir(), "snap-off-")), globalDir: false, silent: true });
    store.upsert(
      mkRecipe("auth/login", [
        { kind: "navigate", url: `${server.url}/login` },
        { kind: "fill", selector: "#username", value: "admin" },
        { kind: "fill", selector: "#password", value: "secret" },
        {
          kind: "click",
          selector: 'button[type="submit"]',
          expectAfter: { urlContains: "/auth-thanks", timeoutMs: 3000 },
        },
      ]),
    );
    store.upsert(mkRecipe("flow", [{ kind: "navigate", url: `${server.url}/about` }], ["auth/login"]));

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      // No `snapshot: true` → first run captures nothing.
      await runRecipeWithRequires({
        page,
        recipe: store.get("flow")!,
        store,
      });
      expect(existsSync(snapshotPath(store.writeDir!, "auth/login"))).toBe(false);
    } finally {
      await ctx.close();
    }
  }, 60000);
});
