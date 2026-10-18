import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../cli-usage.js";
import { requireBaseUrl, warnRebased } from "./cli-common.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function recipe(name: string, url: string): ActionRecipe {
  return {
    name,
    description: "",
    preconditions: [],
    steps: [{ kind: "navigate", url }],
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "ai-extracted",
    status: "verified",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("warnRebased", () => {
  it("warns on stderr about each recipe the base URL moves, and no other", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    warnRebased(
      "load",
      [recipe("a/local", "http://127.0.0.1:4791/login"), recipe("b/staging", "https://staging.example.test/")],
      "https://staging.example.test/app",
    );
    expect(warn.mock.calls).toEqual([
      ["load: a/local was recorded on http://127.0.0.1:4791; replaying it on https://staging.example.test instead"],
    ]);
    // stdout stays the report's, so `--json` output still parses.
    expect(log).not.toHaveBeenCalled();
  });
});

describe("requireBaseUrl", () => {
  it("refuses a base URL with no http(s) origin as a usage error (exit 2)", () => {
    expect(() => requireBaseUrl("staging.example.test")).toThrow(UsageError);
    expect(() => requireBaseUrl("file:///tmp/site")).toThrow(UsageError);
    expect(() => requireBaseUrl("staging.example.test")).toThrow(
      '--base-url must be an absolute http(s) URL, got "staging.example.test"',
    );
    expect(() => requireBaseUrl("http://127.0.0.1:4791/login")).not.toThrow();
  });
});
