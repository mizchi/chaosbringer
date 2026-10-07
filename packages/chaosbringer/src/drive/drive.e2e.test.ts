import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRecipe } from "../recipes/replay.js";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";
import { anthropicDecider, parseDriveDecision, planDecider } from "./deciders.js";
import { drive, type DriveDecider, type DriveInput } from "./drive.js";

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

    const page = await browser.newPage();
    try {
      const replay = await runRecipe(page, result.recipe!);
      expect(replay).toMatchObject({ ok: true });
      await expect.poll(() => page.getByText("Welcome, ada@example.test (pro)").isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

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
