/**
 * `chaosbringer recipes` commands in-process, for what they refuse before a
 * browser starts (the spawned table in `../cli.test.ts` covers the flags).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../cli-usage.js";
import { runRecipesCli } from "./cli.js";
import { RecipeStore } from "./store.js";
import { emptyStats } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recipes-cli-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// repair took no vars: it replayed a templated recipe with the braces typed,
// and "repaired" a login that was not broken.
describe("recipes repair", () => {
  it("refuses a recipe whose {{password}} no --var gives, before a browser launches", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert({
      name: "auth/login",
      description: "",
      preconditions: [{ urlPattern: "/{{tenant}}/" }],
      steps: [
        { kind: "navigate", url: "http://127.0.0.1:9/login" },
        { kind: "fill", selector: "#pw", value: "{{password}}" },
      ],
      postconditions: [],
      requires: [],
      stats: emptyStats(),
      origin: "hand-written",
      status: "verified",
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    // Fails the test fast, rather than starting a browser, should it get that far.
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("a browser was launched"));
    const repair = (...extra: string[]) => runRecipesCli(["repair", "auth/login", "--dir", dir, "--quiet", ...extra]);
    // A precondition's {{tenant}} is not asked for: a replay does not read it.
    await expect(repair()).rejects.toMatchObject({
      name: "UsageError",
      message: 'auth/login: variable "password" is not defined (pass --var password=VALUE, or --vars-file FILE)',
    });
    await expect(repair("--var", "user=x")).rejects.toThrow(UsageError);
    expect(launch).not.toHaveBeenCalled();
  });
});
