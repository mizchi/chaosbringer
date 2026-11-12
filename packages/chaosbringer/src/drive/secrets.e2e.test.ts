/**
 * A password `drive` types, end to end through the CLI: it used to land as
 * it was in the progress line, drive-report.json (twice), recipe.json and the
 * recipe store, and the `recipes verify` command drive printed could not
 * replay a recipe that held `{{password}}` instead, as no recipes command
 * took vars.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";

const PACKAGE_DIR = join(import.meta.dirname, "../..");
const CLI = join(import.meta.dirname, "../cli.ts");
/** Appears nowhere but in what the plan types. */
const PASSWORD = "hunter2-cb-secret";

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: PACKAGE_DIR, timeout: 90_000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

const LOGIN = `<!doctype html><title>Log in</title><h1>Log in</h1>
<form id="f">
  <label>Username <input name="username" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button>Sign in</button>
</form>
<p id="err" role="alert"></p>
<script>
  document.getElementById("f").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (ev.target.password.value === ${JSON.stringify(PASSWORD)}) location.href = "/auth-thanks";
    else document.getElementById("err").textContent = "Wrong password";
  });
</script>`;

/**
 * A GET form: the password lands in the result page's URL, which that page
 * logs, and puts in the error it lets escape when its API call fails.
 */
const LOGIN_GET = `<!doctype html><title>Log in</title><h1>Log in</h1>
<form method="get" action="/result">
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button>Go</button>
</form>`;
const RESULT = `<!doctype html><title>Result</title><h1>Result</h1>
<script>
  console.error("oops at " + location.search);
  fetch("/api/ping").then((r) => { if (!r.ok) throw new Error("api failed at " + location.search); });
</script>`;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("drive keeps a typed password out of its output, and recipes verify replays it from --vars-file", () => {
  let server: TestServer;
  let dir: string;
  let store: string;
  let secrets: string;
  let drove: { status: number | null; stdout: string; stderr: string };

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if (req.url === "/api/ping") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url?.startsWith("/auth-thanks")) res.end(`<!doctype html><title>Welcome</title><h1>Welcome</h1>`);
      else if (req.url === "/login-get") res.end(LOGIN_GET);
      else if (req.url?.startsWith("/result")) res.end(RESULT);
      else res.end(LOGIN);
    });
    dir = mkdtempSync(join(tmpdir(), "chaos-drive-secrets-e2e-"));
    store = join(dir, "store");
    secrets = join(dir, "secrets.json");
    const plan = join(dir, "plan.json");
    writeFileSync(
      plan,
      JSON.stringify([
        { fill: 'textbox "Username"', value: "admin" },
        { fill: 'textbox "Password"', value: PASSWORD },
        { click: 'button "Sign in"' },
      ]),
    );
    drove = await cli([
      "drive", "--url", `${server.url}/login`, "--goal", "log in", "--plan", plan, "--until-url", "auth-thanks",
      "--out", join(dir, "out"), "--save-recipe", "login-test", "--dir", store, "--save-secrets", secrets,
    ]);
  }, 120_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reaches the goal, and the password is nowhere in what it printed or wrote but the secrets file", () => {
    expect(drove.status).toBe(0);
    expect(drove.stdout).toContain('[drive] 1. fill textbox "Password"');
    expect(drove.stdout).toContain('"{{password}}" — ok');
    const written = [join(dir, "out", "recipe.json"), join(dir, "out", "drive-report.json"), ...filesUnder(store)];
    expect(written.length).toBeGreaterThan(2);
    for (const text of [drove.stdout, drove.stderr, ...written.map((f) => readFileSync(f, "utf8"))]) {
      expect(text).not.toContain(PASSWORD);
    }
    const recipe = JSON.parse(readFileSync(join(dir, "out", "recipe.json"), "utf8")) as { steps: { kind: string; value?: string }[] };
    expect(recipe.steps.filter((s) => s.kind === "fill").map((s) => s.value)).toEqual(["admin", "{{password}}"]);
  });

  it("writes the secrets file with mode 0600, and names it in the verify command", () => {
    expect(JSON.parse(readFileSync(secrets, "utf8"))).toEqual({ password: PASSWORD });
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(drove.stdout).toContain(`recipe saved: login-test (verify with: chaosbringer recipes verify login-test --base-url ${server.url} --dir ${store} --vars-file ${secrets})`);
  });

  it("recipes verify --vars-file replays it and promotes it", async () => {
    const r = await cli(["recipes", "verify", "login-test", "--base-url", server.url, "--dir", store, "--vars-file", secrets, "--runs", "2", "--quiet"]);
    expect(r.stdout).toContain("login-test: promoted=true");
    expect(r.status).toBe(0);
  }, 60_000);

  it("recipes verify without vars refuses before the browser starts, naming the variable", async () => {
    const r = await cli(["recipes", "verify", "login-test", "--base-url", server.url, "--dir", store]);
    expect(r.stderr.trimEnd()).toBe(
      'chaosbringer recipes verify: login-test: variable "password" is not defined (pass --var password=VALUE, or --vars-file FILE) (see chaosbringer recipes verify --help)',
    );
    expect(r.status).toBe(2);
  }, 60_000);

  // The page's URL in drive-report.json's problems, and everything --chaos
  // wrote and printed, kept the value an app echoed back.
  it("keeps it out of a problem's URL and of what --chaos writes and prints, where the app echoes it", async () => {
    const plan = join(dir, "plan-get.json");
    writeFileSync(plan, JSON.stringify([{ fill: 'textbox "Password"', value: PASSWORD }, { click: 'button "Go"' }]));
    const out = join(dir, "out-chaos");
    const r = await cli([
      "drive", "--url", `${server.url}/login-get`, "--goal", "log in", "--plan", plan, "--until-url", "/result",
      "--out", out, "--chaos", "--faults", "500", "--quiet",
    ]);
    // The escaped error is a high finding.
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("the app let the API failure escape");
    expect(r.stdout).toContain("api failed at ?password={{password}}");
    const report = readFileSync(join(out, "drive-report.json"), "utf8");
    expect((JSON.parse(report) as { problems: { url: string }[] }).problems.map((p) => p.url)).toContain(`${server.url}/result?password={{password}}`);
    expect(filesUnder(out).map((f) => f.slice(out.length + 1)).sort()).toEqual(["chaos-report.json", "drive-report.json", "recipe.json"]);
    for (const text of [r.stdout, r.stderr, ...filesUnder(out).map((f) => readFileSync(f, "utf8"))]) {
      expect(text).not.toContain(PASSWORD);
    }
  }, 90_000);

  it("drive --secret types a plan's {{name}} from the environment, and keeps it out as well", async () => {
    const plan = join(dir, "plan-secret.json");
    writeFileSync(
      plan,
      JSON.stringify([
        { fill: 'textbox "Username"', value: "admin" },
        { fill: 'textbox "Password"', value: "{{pw}}" },
        { click: 'button "Sign in"' },
      ]),
    );
    const out = join(dir, "out-secret");
    const r = await cli(
      ["drive", "--url", `${server.url}/login`, "--goal", "log in", "--plan", plan, "--until-url", "auth-thanks", "--out", out, "--secret", "pw=CB_E2E_PASSWORD", "--save-recipe", "login-secret", "--dir", store],
      { CB_E2E_PASSWORD: PASSWORD },
    );
    expect(r.status).toBe(0);
    for (const text of [r.stdout, r.stderr, readFileSync(join(out, "recipe.json"), "utf8"), readFileSync(join(out, "drive-report.json"), "utf8")]) {
      expect(text).not.toContain(PASSWORD);
    }
    const recipe = JSON.parse(readFileSync(join(out, "recipe.json"), "utf8")) as { steps: { kind: string; value?: string }[] };
    expect(recipe.steps.filter((s) => s.kind === "fill").map((s) => s.value)).toEqual(["admin", "{{pw}}"]);
    // No --save-secrets: the hint names the variable to supply.
    expect(r.stdout).toContain("--var pw=VALUE)");
    expect(r.stdout).toContain("the recipe types {{pw}}: give each value with --var");
  }, 60_000);
});
