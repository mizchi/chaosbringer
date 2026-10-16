import { describe, expect, it } from "vitest";
import type { ActionRecipe } from "../recipes/types.js";
import { emptyStats } from "../recipes/types.js";
import { verifyCommand } from "./cli.js";

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
    status: "candidate",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

// The hint `drive --save-recipe` prints. It used to be just
// `recipes verify <name>`, which verify refuses (`--base-url is required`,
// exit 2), and which looks in the default store when the recipe went to --dir.
describe("verifyCommand", () => {
  it("passes the origin the recipe was recorded on as --base-url", () => {
    expect(verifyCommand(recipe("fixture/login", "http://127.0.0.1:4791/login?next=1"), undefined)).toBe(
      "chaosbringer recipes verify fixture/login --base-url http://127.0.0.1:4791",
    );
  });

  it("names --dir only for a store verify would not look in", () => {
    const r = recipe("fixture/login", "http://127.0.0.1:4791/login");
    expect(verifyCommand(r, "./chaosbringer-recipes")).not.toContain("--dir");
    expect(verifyCommand(r, "chaosbringer-recipes/")).not.toContain("--dir");
    expect(verifyCommand(r, "out/recipes")).toBe(
      "chaosbringer recipes verify fixture/login --base-url http://127.0.0.1:4791 --dir out/recipes",
    );
  });

  it("quotes what the shell would split or expand", () => {
    expect(verifyCommand(recipe("my login", "http://127.0.0.1:4791/"), "my recipes")).toBe(
      "chaosbringer recipes verify 'my login' --base-url http://127.0.0.1:4791 --dir 'my recipes'",
    );
  });
});
