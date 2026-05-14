/**
 * E2E smoke for `authAttackDriver` against the intentionally vulnerable
 * `/login` and `/signup` pages baked into the fixture site. Verifies
 * the driver:
 *   - detects auth forms (login + signup)
 *   - confirms each of the 5 OWASP-aligned attack classes
 *   - emits findings with the documented severity + reference shape
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { authAttackDriver } from "../../src/drivers/auth-attack/index.js";
import { detectAuthForm } from "../../src/drivers/auth-attack/detect.js";
import type { AuthFinding } from "../../src/drivers/auth-attack/types.js";
import type { DriverStep } from "../../src/drivers/types.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let browser: Browser;

beforeAll(async () => {
  server = await startFixtureServer(0);
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await server.close();
});

async function runOn(path: "/login" | "/signup"): Promise<AuthFinding[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const findings: AuthFinding[] = [];
  const driver = authAttackDriver({
    onFinding: (f) => {
      findings.push(f);
    },
    testCredentials: {
      username: "admin",
      password: "totally-not-the-real-pw",
    },
    maxAttacksPerUrl: 1,
  });
  try {
    await page.goto(`${server.url}${path}`, { waitUntil: "domcontentloaded" });

    const step: DriverStep = {
      url: page.url(),
      page,
      candidates: [],
      history: [],
      stepIndex: 0,
      rng: { next: () => 0 } as DriverStep["rng"],
      screenshot: async () => Buffer.from(""),
      invariantViolations: [],
    };
    const pick = await driver.selectAction(step);
    if (!pick || pick.kind !== "custom") throw new Error("expected custom Pick");
    await pick.perform(page);
    return findings;
  } finally {
    await context.close();
  }
}

describe("authAttackDriver against vulnerable fixture", () => {
  it("detects login + signup forms", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}/login`);
      const login = await detectAuthForm(page);
      expect(login?.type).toBe("login");

      await page.goto(`${server.url}/signup`);
      const signup = await detectAuthForm(page);
      expect(signup?.type).toBe("signup");
    } finally {
      await context.close();
    }
  }, 30000);

  it("/login: surfaces SQLi auth-bypass + username enumeration + missing rate limit", async () => {
    const findings = await runOn("/login");
    const attacks = new Set(findings.map((f) => f.attack));

    expect(attacks.has("sqli-credentials")).toBe(true);
    const sqli = findings.find((f) => f.attack === "sqli-credentials")!;
    expect(sqli.severity).toBe("critical");
    expect(sqli.reference).toMatch(/A03|WSTG-INPV-05/);

    expect(attacks.has("username-enumeration")).toBe(true);
    const enumF = findings.find((f) => f.attack === "username-enumeration")!;
    expect(["medium", "high"]).toContain(enumF.severity);
    expect(enumF.reference).toMatch(/ASVS|WSTG-IDNT-04/);

    expect(attacks.has("rate-limit-login")).toBe(true);
    const rl = findings.find((f) => f.attack === "rate-limit-login")!;
    expect(rl.severity).toBe("medium");
    expect(rl.reference).toMatch(/ASVS|WSTG-ATHN-03/);
  }, 120000);

  it("/signup: surfaces weak-password acceptance + reflected XSS", async () => {
    const findings = await runOn("/signup");
    const attacks = new Set(findings.map((f) => f.attack));

    expect(attacks.has("weak-password-signup")).toBe(true);
    const weak = findings.find((f) => f.attack === "weak-password-signup")!;
    expect(weak.severity).toBe("high");
    expect(weak.reference).toMatch(/NIST|ASVS/);

    expect(attacks.has("xss-credentials")).toBe(true);
    const xss = findings.find((f) => f.attack === "xss-credentials")!;
    expect(["medium", "critical"]).toContain(xss.severity);
    expect(xss.reference).toMatch(/A03|WSTG-INPV-01/);
  }, 120000);
});
