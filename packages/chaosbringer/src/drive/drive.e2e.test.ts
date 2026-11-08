import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRecipe } from "../recipes/replay.js";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";
import { anthropicDecider, parseDriveDecision, planDecider, renderDrivePrompt } from "./deciders.js";
import { drive, type DriveDecider, type DriveDecision, type DriveInput } from "./drive.js";

const HOME = `<!doctype html><title>Home</title>
<div role="dialog" aria-label="Cookies" id="consent"><p>We use cookies.</p>
  <button onclick="document.getElementById('consent').remove()">Reject optional</button></div>
<nav><a href="/login">Sign in</a> <a href="/logout">Log out</a></nav>
<h1>Shop</h1>
<button onclick="fetch('/api/wishlist').then((r) => { if (!r.ok) throw new Error('wishlist failed: ' + r.status); })">Wishlist</button>`;

const LOGIN = `<!doctype html><title>Sign in</title><main><h1>Account</h1>
<form onsubmit="event.preventDefault(); location.href = '/welcome?u=' + encodeURIComponent(this.email.value) + '&plan=' + this.plan.value">
  <label>Email <input name="email" type="email"></label>
  <label>Password <input name="password" type="password"></label>
  <select name="plan" aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
  <button>Sign in</button>
</form></main>`;

/**
 * A GET form, so what is typed lands in the next page's URL, and a page
 * there that logs a console error (a problem stamped with that URL).
 * "Locked" is read-only: a fill of it fails.
 */
const GET_LOGIN = `<!doctype html><title>Get in</title><main><h1>Get in</h1>
<form method="get" action="/noisy">
  <label>User <input name="user"></label>
  <label>Secret <input name="password" type="password" autocomplete="current-password"></label>
  <label>Locked <input name="locked" type="password" readonly></label>
  <button>Go</button>
</form></main>`;
const NOISY = `<!doctype html><title>Noisy</title><main><h1>Noisy</h1>
<script>console.error("noisy page")</script>
<button onclick="document.getElementById('m').textContent = 'All done'">Finish</button><p id="m"></p></main>`;

describe("drive", () => {
  let server: TestServer;
  let browser: Browser;
  const hits: string[] = [];

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      hits.push(req.url ?? "");
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/api/wishlist") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      if (url.pathname === "/login") res.end(LOGIN);
      else if (url.pathname === "/get-login") res.end(GET_LOGIN);
      else if (url.pathname === "/noisy") res.end(NOISY);
      else if (url.pathname === "/welcome") res.end(`<!doctype html><title>Welcome</title><h1>Welcome, ${url.searchParams.get("u")} (${url.searchParams.get("plan")})</h1>`);
      else if (url.pathname === "/logout") res.end(`<!doctype html><title>Bye</title><p>Logged out</p>`);
      else res.end(HOME);
    });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server.close();
  });

  const login = planDecider([
    { click: 'button "Reject optional"' },
    { click: 'link "Sign in"' },
    { fill: 'textbox "Email"', value: "ada@example.test" },
    { fill: 'textbox "Password"', value: "not-a-real-password" },
    { select: 'combobox "Plan"', value: "Pro" },
    { click: 'button "Sign in"' },
  ]);

  it("reaches the goal, and records a recipe that replays it on a fresh page", async () => {
    const result = await drive({
      url: `${server.url}/`,
      goal: "sign in on the pro plan",
      decider: login,
      until: { text: "Welcome, ada@example.test (pro)" },
      browser,
    });
    expect(result.status).toBe("reached");
    expect(result.steps.map((s) => [s.action, s.ok])).toEqual([
      ["click", true],
      ["click", true],
      ["fill", true],
      ["fill", true],
      ["select", true],
      ["click", true],
    ]);
    expect(result.steps[0]!.target).toBe('button "Reject optional" — in dialog "Cookies"');
    expect(result.recipe!.steps.map((s) => s.kind)).toEqual(["navigate", "click", "click", "fill", "fill", "select", "click"]);
    expect(result.recipe!.steps[2]).toEqual({ kind: "click", selector: 'role=link[name="Sign in"s]', expectAfter: { urlContains: "/login" } });
    // The password field's value is a placeholder; secretValues() replays it.
    expect(result.recipe!.steps[4]).toEqual({ kind: "fill", selector: 'role=textbox[name="Password"s]', value: "{{password}}" });
    expect(result.variables).toEqual(["password"]);
    expect(result.secretValues()).toEqual({ password: "not-a-real-password" });

    const page = await browser.newPage();
    try {
      const replay = await runRecipe(page, result.recipe!, { vars: result.secretValues() });
      expect(replay).toMatchObject({ ok: true });
      await expect.poll(() => page.getByText("Welcome, ada@example.test (pro)").isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  // A typed password was copied as it was into the recipe, drive-report.json
  // and the progress line, and the outline the decider read next showed it as
  // the field's value (`textbox "Password": …`).
  describe("secrets", () => {
    const recorder = (answers: Array<(input: DriveInput) => DriveDecision>) => {
      const asked: DriveInput[] = [];
      const decider: DriveDecider = {
        name: "secrets",
        async decide(input) {
          asked.push(input);
          return answers[asked.length - 1]?.(input) ?? { action: "done" };
        },
      };
      return { decider, asked };
    };
    const at = (input: DriveInput, prefix: string) => input.candidates.find((c) => c.description.startsWith(prefix))!.index;

    it("keeps what it types into a password field out of all it returns and shows the decider", async () => {
      const steps: Array<[unknown, unknown]> = [];
      const { decider, asked } = recorder([
        (i) => ({ action: "fill", index: at(i, 'textbox "Email"'), value: "ada@example.test" }),
        (i) => ({ action: "fill", index: at(i, 'textbox "Password"'), value: "first-cb-secret", reasoning: "typing first-cb-secret" }),
        (i) => ({ action: "fill", index: at(i, 'textbox "Password"'), value: "second-cb-secret" }),
        (i) => ({ action: "fill", index: at(i, 'textbox "Password"'), value: "first-cb-secret" }),
        (i) => ({ action: "click", index: at(i, 'button "Sign in"') }),
      ]);
      const result = await drive({
        url: `${server.url}/login`,
        goal: "sign in",
        decider,
        until: { urlIncludes: "/welcome" },
        browser,
        onStep: (entry, decision) => steps.push([entry, decision]),
      });
      expect(result.status).toBe("reached");
      expect(result.steps.map((s) => s.value)).toEqual(["ada@example.test", "{{password}}", "{{password_2}}", "{{password}}", undefined]);
      expect(result.recipe!.steps.filter((s) => s.kind === "fill").map((s) => (s as { value: string }).value)).toEqual([
        "ada@example.test",
        "{{password}}",
        "{{password_2}}",
        "{{password}}",
      ]);
      expect(result.variables).toEqual(["password", "password_2"]);
      expect(result.secretValues()).toEqual({ password: "first-cb-secret", password_2: "second-cb-secret" });
      // The outline after the first fill showed the field's value.
      expect(asked[2]!.outline).toMatch(/textbox "Password"[^\n]*: \{\{password\}\}/);
      expect(asked[2]!.secrets).toEqual(["password"]);
      expect(asked[2]!.history[1]).toMatchObject({ action: "fill", value: "{{password}}" });
      const everything = JSON.stringify({ result, asked, steps });
      expect(everything).not.toContain("cb-secret");
      expect(result.reason).toBe("typing {{password}}");
    }, 60_000);

    it("types a named secret where a decider writes {{name}}, and scrubs it from the URL it lands on", async () => {
      const { decider, asked } = recorder([
        (i) => ({ action: "fill", index: at(i, 'textbox "Email"'), value: "{{login}}@example.test" }),
        (i) => ({ action: "click", index: at(i, 'button "Sign in"') }),
      ]);
      const result = await drive({
        url: `${server.url}/login`,
        goal: "sign in",
        decider,
        until: { text: "Welcome" },
        secrets: { login: "named-cb-token" },
        browser,
      });
      expect(result.status).toBe("reached");
      expect(asked[0]!.secrets).toEqual(["login"]);
      // The welcome page's URL and heading carry what was typed.
      expect(hits.some((h) => h.includes("named-cb-token"))).toBe(true);
      expect(result.finalUrl).toContain("u={{login}}%40example.test");
      expect(result.recipe!.steps.find((s) => s.kind === "fill")).toMatchObject({ value: "{{login}}@example.test" });
      expect(result.variables).toEqual(["login"]);
      expect(JSON.stringify(result)).not.toContain("named-cb-token");
      expect(JSON.stringify(asked)).not.toContain("named-cb-token");
    }, 60_000);

    // problems[].url is the page's URL: it kept the value a GET form put there.
    it("scrubs a problem's URL, in the result and in what the decider is shown", async () => {
      const { decider, asked } = recorder([
        (i) => ({ action: "fill", index: at(i, 'textbox "Secret"'), value: "url-cb-secret" }),
        (i) => ({ action: "click", index: at(i, 'button "Go"') }),
        (i) => ({ action: "click", index: at(i, 'button "Finish"') }),
      ]);
      const result = await drive({ url: `${server.url}/get-login`, goal: "get in", decider, until: { text: "All done" }, browser });
      expect(result.status).toBe("reached");
      const noisy = (p: { kind: string; message: string }) => p.kind === "console" && p.message.includes("noisy page");
      expect(asked[2]!.problems.find(noisy)?.url).toContain("password={{password}}");
      expect(result.problems.find(noisy)?.url).toContain("password={{password}}");
      expect(JSON.stringify({ result, asked })).not.toContain("url-cb-secret");
    }, 60_000);

    // The decider was shown the history as it was recorded: a value typed
    // into a plain field before it was typed into a password field stayed
    // in its entry, raw, on every later ask.
    it("scrubs an earlier entry whose value later became a secret, from the next ask on", async () => {
      const { decider, asked } = recorder([
        (i) => ({ action: "fill", index: at(i, 'textbox "User"'), value: "late-cb-secret" }),
        (i) => ({ action: "fill", index: at(i, 'textbox "Secret"'), value: "late-cb-secret" }),
        (i) => ({ action: "click", index: at(i, 'button "Go"') }),
      ]);
      const result = await drive({ url: `${server.url}/get-login`, goal: "get in", decider, until: { urlIncludes: "/noisy" }, browser });
      expect(result.status).toBe("reached");
      expect(asked[2]!.history.map((h) => h.value)).toEqual(["{{password}}", "{{password}}"]);
      expect(JSON.stringify(asked.slice(2))).not.toContain("late-cb-secret");
      expect(result.steps.map((s) => s.value)).toEqual(["{{password}}", "{{password}}", undefined]);
      expect(result.recipe!.steps.filter((s) => s.kind === "fill").map((s) => (s as { value: string }).value)).toEqual([
        "{{password}}",
        "{{password}}",
      ]);
      expect(JSON.stringify(result)).not.toContain("late-cb-secret");
    }, 60_000);

    it("fails the step of a {{name}} no secret defines, without typing it", async () => {
      const { decider } = recorder([(i) => ({ action: "fill", index: at(i, 'textbox "Email"'), value: "{{nope}}" }), () => ({ action: "give_up" })]);
      const result = await drive({ url: `${server.url}/login`, goal: "g", decider, browser });
      expect(result.steps[0]).toMatchObject({ ok: false, value: "{{nope}}", error: 'variable "nope" is not defined (no secret has that name)' });
    }, 60_000);
  });

  it("reports what broke at each step, and shows it to the decider", async () => {
    const inputs: DriveInput[] = [];
    const decider: DriveDecider = {
      name: "watcher",
      async decide(input) {
        inputs.push(input);
        if (inputs.length === 1) return { action: "click", index: input.candidates.findIndex((c) => c.description.startsWith('button "Wishlist"')) };
        return { action: "give_up", reasoning: "seen enough" };
      },
    };
    const result = await drive({ url: `${server.url}/`, goal: "add to wishlist", decider, browser });
    expect(result.status).toBe("gave-up");
    expect(result.reason).toBe("seen enough");
    const kinds = result.problems.filter((p) => p.step === 0).map((p) => p.kind);
    expect(kinds).toContain("http");
    expect(kinds).toContain("unhandled-rejection");
    expect(result.steps[0]!.problems.some((p) => p.startsWith("http: GET") && p.endsWith("/api/wishlist -> 500"))).toBe(true);
    expect(inputs[1]!.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(["http", "unhandled-rejection"]));
    expect(inputs[0]!.outline).toContain('[#0] button "Reject optional"');
  }, 60_000);

  // drive --ignore-error / --ignore-preset: nothing checked that the
  // patterns reach the problem watch.
  it("does not record a problem an ignoreErrorPatterns entry matches, and still records the rest", async () => {
    const decider: DriveDecider = {
      name: "watcher",
      async decide(input) {
        if (input.stepIndex === 0) return { action: "click", index: input.candidates.findIndex((c) => c.description.startsWith('button "Wishlist"')) };
        return { action: "give_up", reasoning: "seen enough" };
      },
    };
    const result = await drive({ url: `${server.url}/`, goal: "add to wishlist", decider, browser, ignoreErrorPatterns: ["api/wishlist"] });
    const step0 = result.problems.filter((p) => p.step === 0);
    expect(step0.some((p) => /api\/wishlist/i.test(p.message))).toBe(false);
    expect(step0.map((p) => p.kind)).not.toContain("http");
    expect(step0.map((p) => p.kind)).toContain("unhandled-rejection");
  }, 60_000);

  it("does not take the decider's word for done while the goal does not hold", async () => {
    const inputs: DriveInput[] = [];
    let first = true;
    const inner = planDecider([{ click: 'link "Sign in"' }]);
    const decider: DriveDecider = {
      name: "eager",
      async decide(input) {
        inputs.push(input);
        if (first) {
          first = false;
          return { action: "done", reasoning: "looks done" };
        }
        return inner.decide(input);
      },
    };
    const result = await drive({ url: `${server.url}/`, goal: "open the sign-in page", decider, until: { urlIncludes: "/login" }, browser });
    expect(result.status).toBe("reached");
    expect(inputs[1]!.feedback).toContain('the URL contains "/login"');
  }, 60_000);

  // A decider that kept answering done (a plan that ran out, a model sure it
  // was finished) while `until` did not hold was asked again forever: each
  // answer reset the failure count before it was counted, and gave its step back.
  describe("stops as stuck when the decider keeps answering without acting", () => {
    const stub = (answer: (input: DriveInput) => DriveDecision) => {
      const asked: DriveInput[] = [];
      const decider: DriveDecider = {
        name: "stub",
        async decide(input) {
          asked.push(input);
          return answer(input);
        },
      };
      return { decider, asked };
    };
    const until = { urlIncludes: "/nowhere" };

    it("always done", async () => {
      const { decider, asked } = stub(() => ({ action: "done", reasoning: "looks done" }));
      const result = await drive({ url: `${server.url}/`, goal: "g", decider, until, maxFailedDecisions: 3, browser });
      expect(result.status).toBe("stuck");
      expect(result.reason).toBe("the decider kept answering done while the success condition did not hold");
      expect(asked).toHaveLength(3);
      expect(asked[2]!.feedback).toContain('the URL contains "/nowhere"');
      expect(result.steps).toEqual([]);
    }, 30_000);

    it("always an index that does not exist", async () => {
      const { decider, asked } = stub(() => ({ action: "click", index: 999 }));
      const result = await drive({ url: `${server.url}/`, goal: "g", decider, until, maxFailedDecisions: 3, browser });
      expect(result.status).toBe("stuck");
      expect(result.reason).toBe("the decider kept picking indices that do not exist");
      expect(asked).toHaveLength(3);
      expect(asked[1]!.feedback).toBe("There is no candidate #999; pick one of the listed indices.");
    }, 30_000);

    it("refused answers of different kinds count together until an action runs", async () => {
      const answers: DriveDecision[] = [{ action: "done" }, { action: "press", key: "Tab" }, { action: "done" }, { action: "click", index: 999 }, { action: "done" }];
      const { decider, asked } = stub(() => answers[Math.min(asked.length - 1, answers.length - 1)]!);
      const result = await drive({ url: `${server.url}/`, goal: "g", decider, until, maxFailedDecisions: 3, browser });
      expect(result.status).toBe("stuck");
      // Named for every kind, not only the last answer's.
      expect(result.reason).toBe(
        'the decider gave 3 answers in a row that led to no action (2 "done" while the success condition did not hold, 1 index not on the page)',
      );
      expect(asked).toHaveLength(5);
      expect(result.steps.map((s) => s.action)).toEqual(["press"]);
    }, 30_000);

    it("no usable answer is the reason, not an earlier answer's reasoning", async () => {
      // One action with its reasoning, then nothing usable.
      const answers: DriveDecision[] = [{ action: "press", key: "Tab", reasoning: "move focus" }];
      const decider: DriveDecider = { name: "stub", decide: async () => answers.shift() ?? null };
      const result = await drive({ url: `${server.url}/`, goal: "g", decider, until, maxFailedDecisions: 3, browser });
      expect(result.status).toBe("stuck");
      expect(result.reason).toBe("the decider gave no usable answer");
    }, 30_000);

    it("refused answers between actions use no step", async () => {
      // Two refused answers, then an action, over and over: never stuck, never
      // reached, and each action costs maxFailedDecisions asks at most.
      const cycle: DriveDecision[] = [{ action: "done" }, { action: "click", index: 999 }, { action: "press", key: "Tab" }];
      const { decider, asked } = stub(() => cycle[(asked.length - 1) % cycle.length]!);
      const result = await drive({ url: `${server.url}/`, goal: "g", decider, until, maxSteps: 3, maxFailedDecisions: 3, browser });
      expect(result.status).toBe("out-of-steps");
      expect(result.steps).toHaveLength(3);
      expect(asked).toHaveLength(3 * 3);
    }, 30_000);

    it("reads maxFailedDecisions below 1 as 1, not as stuck before the first ask", async () => {
      const { decider, asked } = stub(() => ({ action: "press", key: "Tab" }));
      const result = await drive({ url: `${server.url}/`, goal: "g", decider, until, maxSteps: 2, maxFailedDecisions: 0, browser });
      expect(result.status).toBe("out-of-steps");
      expect(result.steps).toHaveLength(2);
      expect(asked).toHaveLength(2);
    }, 30_000);

    it("a plan that ran out before the goal held stops at once", async () => {
      const plan = planDecider([{ click: 'button "Reject optional"' }]);
      let asked = 0;
      const decider: DriveDecider = { name: "plan", decide: (input) => (asked++, plan.decide(input)) };
      const result = await drive({ url: `${server.url}/`, goal: "g", decider, until, browser });
      expect(result.status).toBe("stuck");
      expect(result.reason).toBe('the plan is complete, but the success condition does not hold (the URL contains "/nowhere")');
      expect(asked).toBe(2);
      expect(result.steps.map((s) => [s.action, s.ok])).toEqual([["click", true]]);
    }, 30_000);
  });

  it("refuses a link to an excluded URL", async () => {
    const before = hits.filter((h) => h === "/logout").length;
    const result = await drive({
      url: `${server.url}/`,
      goal: "log out",
      decider: planDecider([{ click: 'link "Log out"' }]),
      excludePatterns: ["/logout"],
      maxSteps: 1,
      browser,
    });
    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[0]!.error).toContain("excluded");
    expect(hits.filter((h) => h === "/logout").length).toBe(before);
  }, 60_000);

  it("records a video with the actions on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-video-"));
    const video = join(dir, "run.webm");
    const result = await drive({
      url: `${server.url}/`,
      goal: "open the sign-in page",
      decider: planDecider([{ click: 'button "Reject optional"' }, { click: 'link "Sign in"' }]),
      until: { urlIncludes: "/login" },
      video,
      browser,
    });
    expect(result.video).toBe(video);
    expect(existsSync(video) && statSync(video).size > 1000).toBe(true);
  }, 60_000);

  // Playwright titles a fill `Fill "<value>"` on the video: drive hides the
  // titles around a secret's fill, and shows them again even when it fails.
  it("hides the video's action titles around a secret's fill, and only there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-video-"));
    const calls: string[] = [];
    const spied = new Proxy(browser, {
      get(target, key) {
        if (key === "newContext") {
          return async (options?: Parameters<Browser["newContext"]>[0]) => {
            const context = await target.newContext(options);
            const newPage = context.newPage.bind(context);
            context.newPage = async () => {
              const page = await newPage();
              const { screencast } = page;
              const hide = screencast.hideActions.bind(screencast);
              const show = screencast.showActions.bind(screencast);
              screencast.hideActions = async () => {
                calls.push("hide");
                return hide();
              };
              screencast.showActions = async (o) => {
                calls.push("show");
                return show(o);
              };
              return page;
            };
            return context;
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const steps: string[] = [];
    const result = await drive({
      url: `${server.url}/get-login`,
      goal: "get in",
      decider: planDecider([
        { fill: 'textbox "User"', value: "plain-text" },
        { fill: 'textbox "Secret"', value: "vid-cb-secret" },
        { fill: 'textbox "Locked"', value: "vid-cb-secret" },
        { click: 'button "Go"' },
      ]),
      until: { urlIncludes: "/noisy" },
      video: join(dir, "run.webm"),
      actionTimeoutMs: 1000,
      browser: spied,
      onStep: (s) => steps.push([s.action, s.value, s.ok ? "ok" : "failed"].filter(Boolean).join(" ")),
    });
    expect(result.status).toBe("reached");
    expect(steps).toEqual(["fill plain-text ok", "fill {{password}} ok", "fill {{password}} failed", "click ok"]);
    // The opening show, then a hide and a show around each secret fill.
    expect(calls).toEqual(["show", "hide", "show", "hide", "show"]);
  }, 60_000);

  it("binds its browser, so another client can attach and take over where it stopped", async () => {
    const own = await chromium.launch();
    let seenByOther = "";
    try {
      const result = await drive({
        url: `${server.url}/`,
        goal: "open the sign-in page",
        decider: planDecider([{ click: 'button "Reject optional"' }, { click: 'link "Sign in"' }]),
        until: { urlIncludes: "/login" },
        browser: own,
        bind: "drive-test",
        keepOpen: async (r) => {
          // What an MCP client or `playwright cli attach drive-test` does.
          const other = await chromium.connect(r.bound!.endpoint);
          try {
            const page = other.contexts()[0]!.pages()[0]!;
            seenByOther = page.url();
            await page.getByRole("textbox", { name: "Email" }).fill("taken@over.test");
            await page.getByRole("button", { name: "Sign in" }).click();
            await page.waitForURL(/welcome/);
            seenByOther = page.url();
          } finally {
            await other.close();
          }
        },
      });
      expect(result.status).toBe("reached");
      expect(result.bound).toMatchObject({ title: "drive-test" });
      expect(result.bound!.endpoint.length).toBeGreaterThan(0);
      expect(seenByOther).toContain("/welcome?u=taken%40over.test");
    } finally {
      await own.close();
    }
  }, 60_000);

  it("asks a model with the outline and acts on its JSON answer", async () => {
    const bodies: { system: string; messages: { content: { type: string; text?: string }[] }[] }[] = [];
    const answers = ['{"action":"click","index":0,"reasoning":"close the dialog"}', '```json\n{"action":"click","index":0,"reasoning":"sign in"}\n```'];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ content: [{ type: "text", text: answers[bodies.length - 1] ?? '{"action":"give_up"}' }] }), { status: 200 });
    }) as typeof fetch;
    const result = await drive({
      url: `${server.url}/`,
      goal: "open the sign-in page",
      decider: anthropicDecider({ apiKey: "test", fetch: fetchImpl }),
      until: { urlIncludes: "/login" },
      browser,
    });
    expect(result.status).toBe("reached");
    expect(result.decider).toBe("anthropic/claude-haiku-4-5-20251001");
    const text = bodies[0]!.messages[0]!.content.find((c) => c.type === "text")!.text!;
    expect(text).toContain("Goal: open the sign-in page");
    expect(text).toContain('#0 button "Reject optional" — in dialog "Cookies"');
    expect(text).toContain('[#1] link "Sign in"');
    expect(bodies[0]!.system).toContain("accessibility outline");
  }, 60_000);
});

describe("parseDriveDecision", () => {
  it("reads each action, and refuses what it cannot act on", () => {
    expect(parseDriveDecision('{"action":"fill","index":1,"value":"x","submit":true}', 2)).toEqual({ action: "fill", index: 1, value: "x", submit: true });
    expect(parseDriveDecision('Sure! {"action":"press","key":"Escape"} hope that helps', 0)).toEqual({ action: "press", key: "Escape" });
    expect(parseDriveDecision('{"action":"done","reasoning":"r"}', 0)).toEqual({ action: "done", reasoning: "r" });
    expect(parseDriveDecision('{"action":"click","index":5}', 2)).toBeNull();
    expect(parseDriveDecision('{"action":"fill","index":0}', 2)).toBeNull();
    expect(parseDriveDecision('{"action":"jump"}', 2)).toBeNull();
    expect(parseDriveDecision("no json here", 2)).toBeNull();
  });
});

describe("renderDrivePrompt", () => {
  const input = (secrets?: string[]): DriveInput => ({
    goal: "g",
    url: "http://x.test/",
    title: "t",
    stepIndex: 1,
    stepsLeft: 3,
    outline: '- textbox "Password": {{password}}',
    candidates: [],
    history: [{ step: 0, action: "fill", target: 'textbox "Password"', value: "{{password}}", ok: true, url: "http://x.test/", problems: [] }],
    problems: [],
    ...(secrets ? { secrets } : {}),
    screenshot: async () => Buffer.from(""),
  });

  it("lists the secrets the model can type by name, and shows a filled one by its placeholder", () => {
    const text = renderDrivePrompt("{{feedback}}{{secrets}}Done so far:\n{{history}}", input(["password", "pw"]));
    expect(text).toBe(
      "Secrets you can type by name: {{password}}, {{pw}}. Fill with exactly that text; the value is typed for you.\n" +
        'Done so far:\n0. fill textbox "Password" "{{password}}" — ok; now at http://x.test/',
    );
    expect(renderDrivePrompt("{{secrets}}x", input())).toBe("x");
  });
});
