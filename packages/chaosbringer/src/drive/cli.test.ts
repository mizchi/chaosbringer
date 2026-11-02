import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageError } from "../cli-usage.js";
import type { ActionRecipe } from "../recipes/types.js";
import { emptyStats } from "../recipes/types.js";
import { planFrom, verifyCommand } from "./cli.js";

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

// A plan drive cannot follow is how it was invoked: as a plain Error it was
// `drive failed: …` and exit 1, which drive's help says is "the goal was not
// reached". A UsageError is one `chaosbringer drive:` line and exit 2.
describe("planFrom", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-drive-plan-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const plan = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  const refusal = (path: string) => {
    try {
      planFrom(path);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      return (err as Error).message;
    }
    return undefined;
  };

  it("reads a plan of steps, with /re/ targets as regexes", () => {
    expect(refusal(plan("ok.json", JSON.stringify([{ click: "/sign in/i" }, { press: "Enter" }])))).toBeUndefined();
  });

  it("names --plan and the path for a file it cannot use", () => {
    const missing = join(dir, "missing.json");
    expect(refusal(missing)).toBe(`--plan ${missing}: no such file`);
    const notJson = plan("bad.json", "[{click:");
    expect(refusal(notJson)).toMatch(new RegExp(`^--plan ${notJson}: not a plan file \\(not JSON: .+\\)$`));
    const object = plan("object.json", "{}");
    expect(refusal(object)).toBe(`--plan ${object}: expected a JSON array of steps`);
  });

  it("names the step that is wrong", () => {
    const notStep = plan("not-step.json", JSON.stringify([{ click: "a" }, 7]));
    expect(refusal(notStep)).toBe(`--plan ${notStep}: step 1 is not an object`);
    const unknown = plan("unknown.json", JSON.stringify([{ hover: "a" }]));
    expect(refusal(unknown)).toBe(`--plan ${unknown}: step 0 is not click / fill+value / select+value / press`);
    const target = plan("target.json", JSON.stringify([{ click: 1 }]));
    expect(refusal(target)).toBe(`--plan ${target}: step 0's target must be a string`);
    const regex = plan("regex.json", JSON.stringify([{ click: "/(/" }]));
    expect(refusal(regex)).toMatch(
      new RegExp(`^--plan ${regex}: step 0's target "/\\(/" is not a valid regex \\(Invalid regular expression: .+\\)$`),
    );
  });
});
