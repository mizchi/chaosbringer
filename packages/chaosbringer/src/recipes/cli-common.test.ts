import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UsageError } from "../cli-usage.js";
import { parseVarFlags, requireBaseUrl, requireVars, VAR_OPTIONS, warnRebased } from "./cli-common.js";
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

// `recipes verify`, `recipes repair` and `load` had no way to pass vars, so a
// recipe with `{{password}}` could not be replayed from the CLI at all.
describe("parseVarFlags", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-vars-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  /** As the commands read their argv: `--var` repeatable, `--vars-file` once. */
  const parse = (argv: string[]) => parseVarFlags(parseArgs({ args: argv, options: VAR_OPTIONS, strict: true }).values);
  const refusal = (argv: string[]) => {
    try {
      parse(argv);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      return (err as Error).message;
    }
    return undefined;
  };

  it("is {} with neither flag", () => {
    expect(parse([])).toEqual({});
  });

  it("reads repeated --var, splitting at the first =, an empty value kept", () => {
    expect(parse(["--var", "user=ada", "--var", "q=a=b", "--var", "empty=", "--var", "user.email=a@b.test"])).toEqual({
      user: "ada",
      q: "a=b",
      empty: "",
      "user.email": "a@b.test",
    });
  });

  it("reads a --vars-file of strings, numbers and booleans, and lets --var win over it", () => {
    const vars = file("vars.json", JSON.stringify({ password: "from-file", id: 7, admin: false }));
    expect(parse(["--vars-file", vars, "--var", "password=from-flag"])).toEqual({ password: "from-flag", id: 7, admin: false });
  });

  it("refuses a --var with no =, an empty name or a name a placeholder cannot use", () => {
    expect(refusal(["--var", "password"])).toBe('--var "password": expected NAME=VALUE');
    expect(refusal(["--var", "=x"])).toBe('--var "=x": expected NAME=VALUE');
    expect(refusal(["--var", "1st=x"])).toBe('--var "1st=x": "1st" is not a variable name (letters, digits, _ . -, starting with a letter or _)');
  });

  it("refuses a --vars-file that is missing, not JSON or not an object of plain values, naming it", () => {
    const missing = join(dir, "missing.json");
    expect(refusal(["--vars-file", missing])).toBe(`--vars-file ${missing}: no such file`);
    const sub = join(dir, "a-dir");
    mkdirSync(sub);
    expect(refusal(["--vars-file", sub])).toBe(`--vars-file ${sub}: is a directory, not a file`);
    const notJson = file("bad.json", "{password:");
    expect(refusal(["--vars-file", notJson])).toMatch(new RegExp(`^--vars-file ${notJson}: not a vars file \\(not JSON: .+\\)$`));
    const list = file("list.json", "[]");
    expect(refusal(["--vars-file", list])).toBe(`--vars-file ${list}: expected a JSON object of variable names to values`);
    const nested = file("nested.json", JSON.stringify({ user: { name: "ada" } }));
    expect(refusal(["--vars-file", nested])).toBe(`--vars-file ${nested}: "user" must be a string, number or boolean, got object`);
    const nul = file("null.json", JSON.stringify({ user: null }));
    expect(refusal(["--vars-file", nul])).toBe(`--vars-file ${nul}: "user" must be a string, number or boolean, got null`);
    const badName = file("name.json", JSON.stringify({ "my var": "x" }));
    expect(refusal(["--vars-file", badName])).toMatch(/^--vars-file .+: "my var" is not a variable name/);
  });
});

describe("requireVars", () => {
  const templated: ActionRecipe = {
    ...recipe("site/login", "{{base}}/login"),
    steps: [
      { kind: "navigate", url: "{{base}}/login" },
      { kind: "fill", selector: "#p", value: "{{password}}" },
    ],
    postconditions: [{ hasSelector: "text=Hi {{user}}" }],
  };

  it("passes a recipe every placeholder of which vars define, and one with none", () => {
    expect(() => requireVars([templated], { base: "http://a.test", password: "pw", user: "ada" })).not.toThrow();
    expect(() => requireVars([recipe("plain", "http://a.test/")], {})).not.toThrow();
  });

  it("refuses, naming the recipe and each variable it lacks", () => {
    expect(() => requireVars([templated], { base: "http://a.test", user: "ada" })).toThrow(
      new UsageError('site/login: variable "password" is not defined (pass --var password=VALUE, or --vars-file FILE)'),
    );
    expect(() => requireVars([templated], { base: "http://a.test" })).toThrow(
      'site/login: variables "password", "user" are not defined (pass --var password=VALUE --var user=VALUE, or --vars-file FILE)',
    );
  });
});
