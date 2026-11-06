import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCrawlArgs } from "../cli-crawl-options.js";
import { UsageError } from "../cli-usage.js";
import { COMMON_IGNORE_PATTERNS, IGNORE_PRESETS } from "../ignore-presets.js";
import type { ActionRecipe } from "../recipes/types.js";
import { emptyStats } from "../recipes/types.js";
import {
  checkSecretsPath,
  driveCrawlOptions,
  driveRunOptions,
  parseSecretFlags,
  planFrom,
  runDriveCli,
  verifyCommand,
  writeSecretsFile,
} from "./cli.js";

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

  // drive records a password as `{{password}}`, and verify refuses a recipe
  // whose placeholders it has no values for.
  it("passes the secrets file drive wrote, or a --var to fill in for each placeholder", () => {
    const r = recipe("fixture/login", "http://127.0.0.1:4791/login");
    expect(verifyCommand(r, undefined, { variables: ["password"], varsFile: "out/secrets.json" })).toBe(
      "chaosbringer recipes verify fixture/login --base-url http://127.0.0.1:4791 --vars-file out/secrets.json",
    );
    expect(verifyCommand(r, undefined, { variables: ["password", "one_time_code"] })).toBe(
      "chaosbringer recipes verify fixture/login --base-url http://127.0.0.1:4791 --var password=VALUE --var one_time_code=VALUE",
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

describe("planFrom with secrets", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-drive-plan-secrets-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("takes a {{name}} value a --secret names, and refuses one none does before anything runs", () => {
    const path = join(dir, "plan.json");
    writeFileSync(path, JSON.stringify([{ fill: "Email", value: "a@b.test" }, { fill: "Password", value: "{{password}}" }]));
    expect(() => planFrom(path, new Set(["password"]))).not.toThrow();
    expect(() => planFrom(path)).toThrow(
      new UsageError(`--plan ${path}: step 1's value uses {{password}}, which no --secret names (add --secret password=ENV_VAR)`),
    );
  });
});

describe("parseSecretFlags", () => {
  const env = { CB_PW: "pw-from-env", CB_EMPTY: "" };
  const refusal = (flags: string[]) => {
    try {
      parseSecretFlags(flags, env);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      return (err as Error).message;
    }
    return undefined;
  };

  it("reads each name=ENV_VAR from the environment", () => {
    expect(parseSecretFlags(["password=CB_PW", "user.pw=CB_PW"], env)).toEqual({ password: "pw-from-env", "user.pw": "pw-from-env" });
    expect(parseSecretFlags([], env)).toEqual({});
  });

  it("refuses, naming the flag, what it cannot type", () => {
    expect(refusal(["password"])).toBe('--secret "password": expected NAME=ENV_VAR');
    expect(refusal(["=CB_PW"])).toBe('--secret "=CB_PW": expected NAME=ENV_VAR');
    expect(refusal(["password="])).toBe('--secret "password=": expected NAME=ENV_VAR');
    expect(refusal(["my pw=CB_PW"])).toMatch(/^--secret "my pw=CB_PW": "my pw" is not a variable name/);
    expect(refusal(["password=CB_UNSET_FOR_TEST"])).toBe('--secret "password=CB_UNSET_FOR_TEST": environment variable CB_UNSET_FOR_TEST is not set');
    expect(refusal(["password=CB_EMPTY"])).toBe('--secret "password=CB_EMPTY": environment variable CB_EMPTY is empty');
    expect(refusal(["password=CB_PW", "password=CB_PW"])).toBe('--secret "password=CB_PW": password is given twice');
  });
});

describe("--save-secrets", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-drive-secrets-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const refusal = (path: string) => {
    try {
      checkSecretsPath(path);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      return (err as Error).message;
    }
    return undefined;
  };

  it("takes a path that is not there, or a regular file it can overwrite", () => {
    expect(refusal(join(dir, "new", "secrets.json"))).toBeUndefined();
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "{}");
    expect(refusal(existing)).toBeUndefined();
  });

  it("refuses a directory, a symlink, or a file it cannot write", () => {
    const sub = join(dir, "a-dir");
    mkdirSync(sub);
    expect(refusal(sub)).toBe(`--save-secrets ${sub}: exists and is not a regular file`);
    const target = join(dir, "target.json");
    writeFileSync(target, "{}");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    expect(refusal(link)).toBe(`--save-secrets ${link}: is a symlink; give the file itself`);
    // root can write a read-only file, so this only holds for anyone else.
    if (process.getuid?.() !== 0) {
      const ro = join(dir, "read-only.json");
      writeFileSync(ro, "{}");
      chmodSync(ro, 0o400);
      expect(refusal(ro)).toBe(`--save-secrets ${ro}: exists and cannot be written`);
    }
  });

  // It used to pass a path whose directory could not be made, and fail
  // after the run (exit 1, the recipe not saved).
  it("refuses a new file in a directory it cannot create or write, and creates the one it can", () => {
    const nested = join(dir, "made", "here", "secrets.json");
    expect(refusal(nested)).toBeUndefined();
    expect(statSync(join(dir, "made", "here")).isDirectory()).toBe(true);
    // sysfs refuses every new entry, root's too.
    if (process.platform === "linux" && existsSync("/sys/kernel")) {
      expect(refusal("/sys/cb-no-such-dir/secrets.json")).toMatch(/^--save-secrets \/sys\/cb-no-such-dir\/secrets\.json: cannot write a file in \/sys\/cb-no-such-dir \(/);
    }
    if (process.getuid?.() !== 0) {
      const locked = join(dir, "locked");
      mkdirSync(locked, { mode: 0o500 });
      expect(refusal(join(locked, "sub", "secrets.json"))).toMatch(/cannot write a file in/);
      expect(refusal(join(locked, "secrets.json"))).toMatch(/cannot write a file in/);
    }
  });

  // The check creates a missing directory: a run another check refuses
  // should not leave one behind.
  it("creates no directory for a run refused on another flag", async () => {
    const parent = join(dir, "never-made");
    await expect(
      runDriveCli(["--url", "http://127.0.0.1:9/", "--goal", "g", "--plan", join(dir, "missing-plan.json"), "--save-secrets", join(parent, "secrets.json")]),
    ).rejects.toThrow(new UsageError(`--plan ${join(dir, "missing-plan.json")}: no such file`));
    expect(existsSync(parent)).toBe(false);
  });

  it("writes the vars as JSON readable by its owner only, also over a file that was readable by all", () => {
    const fresh = join(dir, "out", "fresh.json");
    writeSecretsFile(fresh, { password: "pw" });
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ password: "pw" });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    const wide = join(dir, "wide.json");
    writeFileSync(wide, "old", { mode: 0o644 });
    chmodSync(wide, 0o644);
    writeSecretsFile(wide, { password: "pw2" });
    expect(statSync(wide).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(wide, "utf8"))).toEqual({ password: "pw2" });
  });
});

// `drive --settle adaptive` and `drive --timeout 5000` exited 2 as unknown
// options: the crawl's flags that fit a drive now parse as the crawl's do.
describe("drive's crawl flags", () => {
  const base = ["--url", "http://127.0.0.1:9/", "--goal", "x"];
  const flags = [
    "--timeout", "5000", "--settle", "250", "--ignore-error", "noise", "--ignore-analytics", "--ignore-preset", "maps",
    "--device", "Pixel 7", "--network", "fast-3g", "--exclude", "/logout",
  ];

  it("parses them all, and refuses nothing before the plan is read", async () => {
    await expect(runDriveCli([...base, ...flags, "--plan", "missing-plan.json"])).rejects.toThrow(
      "--plan missing-plan.json: no such file",
    );
    // An input file among them is read first, as the crawl reads it.
    await expect(runDriveCli([...base, "--har-replay", "missing.har", "--plan", "p.json"])).rejects.toThrow(
      "--har-replay missing.har: no such file",
    );
  });

  it("builds drive's options from them by the crawl's builder", () => {
    const values = parseCrawlArgs([...flags, "--har-replay", "net.har", "--storage-state", "s.json"]).values;
    const run = driveRunOptions(driveCrawlOptions(values, "http://x/"));
    expect(run).toMatchObject({
      navigationTimeoutMs: 5000,
      settleQuietMs: 250,
      harReplay: "net.har",
      network: "fast-3g",
      contextOptions: { storageState: "s.json", userAgent: expect.stringContaining("Pixel 7") },
    });
    expect(run.ignoreErrorPatterns).toEqual(expect.arrayContaining(["noise", ...COMMON_IGNORE_PATTERNS, ...IGNORE_PRESETS.maps!]));
    expect(driveRunOptions(driveCrawlOptions(parseCrawlArgs(["--settle", "adaptive"]).values, "http://x/"))).toEqual({});
  });

  it("refuses what the crawl refuses, and --settle networkidle, which a drive never does", async () => {
    await expect(runDriveCli([...base, "--timeout", "5s"])).rejects.toThrow('--timeout must be a finite number (got "5s")');
    await expect(runDriveCli([...base, "--device", "Nope 9"])).rejects.toThrow('--device "Nope 9" is not a known Playwright device descriptor');
    await expect(runDriveCli([...base, "--exclude", "("])).rejects.toThrow(/--exclude "\(" is not a valid regex/);
    await expect(runDriveCli([...base, "--settle", "networkidle"])).rejects.toThrow(
      "--settle networkidle does not apply to drive: it settles adaptively after every step",
    );
    await expect(runDriveCli([...base, "--setle", "5"])).rejects.toThrow("unknown option --setle: did you mean --settle?");
  });
});
