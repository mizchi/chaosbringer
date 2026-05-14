/**
 * OWASP-aligned attack scenarios for auth forms. Each attack is a
 * pure async function that takes a `DetectedAuthForm` (+ a context
 * bag) and returns the findings it produced.
 *
 * Why one file rather than one-per-attack: each routine is ~30-60
 * lines, the OWASP refs naturally live as a table at the top of the
 * file, and the attacks share helpers (resetForm, submit, etc.) that
 * would otherwise need their own module.
 *
 * Each attack is responsible for **not** leaving the form in a
 * half-submitted state — subsequent attacks expect the page to be
 * fresh-ish. We call `resetForm()` before each attack and after
 * navigations.
 */
import type { Page } from "playwright";
import {
  NONEXISTENT_USERNAME,
  SQLI_AUTH_BYPASS_PAYLOADS,
  SQL_ERROR_SIGNATURES,
  WEAK_PASSWORDS,
  XSS_AUTH_MARKER,
  XSS_CREDENTIAL_PAYLOADS,
  freshTestEmail,
} from "./payloads.js";
import type {
  AuthAttackName,
  AuthFinding,
  AuthFindingSeverity,
  DetectedAuthForm,
} from "./types.js";

export interface AttackContext {
  page: Page;
  startUrl: string;
  testCredentials: { username: string; password: string };
  verbose: boolean;
}

interface AttackResult {
  findings: AuthFinding[];
}

const REFS = {
  weakPassword:
    "OWASP ASVS V2.1.7 / NIST SP 800-63B §5.1.1.2 (compromised-password check)",
  usernameEnum:
    "OWASP ASVS V2.2.1 / WSTG-IDNT-04 (account enumeration)",
  sqli: "OWASP A03:2021 Injection / WSTG-INPV-05",
  xss: "OWASP A03:2021 Injection / WSTG-INPV-01",
  rateLimit: "OWASP ASVS V2.2.1 / WSTG-ATHN-03 (rate-limiting)",
} as const;

export async function runAttack(
  attack: AuthAttackName,
  form: DetectedAuthForm,
  ctx: AttackContext,
): Promise<AuthFinding[]> {
  switch (attack) {
    case "weak-password-signup":
      return (await attackWeakPassword(form, ctx)).findings;
    case "username-enumeration":
      return (await attackUsernameEnum(form, ctx)).findings;
    case "sqli-credentials":
      return (await attackSqliCredentials(form, ctx)).findings;
    case "xss-credentials":
      return (await attackXssCredentials(form, ctx)).findings;
    case "rate-limit-login":
      return (await attackRateLimit(form, ctx)).findings;
  }
}

// -------- weak-password-signup --------

async function attackWeakPassword(
  form: DetectedAuthForm,
  ctx: AttackContext,
): Promise<AttackResult> {
  if (form.type !== "signup") {
    return { findings: [] }; // not applicable to login forms
  }
  const findings: AuthFinding[] = [];
  for (const weak of WEAK_PASSWORDS) {
    await page_navigate(ctx, ctx.startUrl);
    const refreshed = await reDetectForm(ctx.page, form);
    if (!refreshed) break;

    const email = freshTestEmail(`weakpw`);
    await safeFill(refreshed.emailField ?? refreshed.usernameField, email);
    await safeFill(refreshed.passwordField, weak);
    if (refreshed.confirmPasswordField) {
      await safeFill(refreshed.confirmPasswordField, weak);
    }

    const navigated = await submitAndWait(ctx.page, refreshed.submitButton, ctx.startUrl);
    const reflectedRejection = await pageMentionsPasswordPolicy(ctx.page);
    const accepted = navigated && !reflectedRejection;

    if (accepted) {
      findings.push({
        attack: "weak-password-signup",
        severity: "high",
        url: ctx.startUrl,
        formType: "signup",
        description: `Signup accepted weak password "${weak}" without warning. NIST 800-63B requires rejecting compromised-password-list entries.`,
        reference: REFS.weakPassword,
        evidence: { weakPassword: weak, postSubmitUrl: ctx.page.url() },
      });
      // One confirmed acceptance is enough — don't pollute the report.
      break;
    }
  }
  return { findings };
}

async function pageMentionsPasswordPolicy(page: Page): Promise<boolean> {
  const txt = await page
    .locator("body")
    .innerText({ timeout: 500 })
    .catch(() => "");
  return /weak|short|too\s+common|chosen.*too|insecure|compromised/i.test(txt.slice(0, 4000));
}

// -------- username-enumeration --------

async function attackUsernameEnum(
  form: DetectedAuthForm,
  ctx: AttackContext,
): Promise<AttackResult> {
  if (form.type !== "login") return { findings: [] };

  const messageFor = async (user: string, password: string): Promise<string> => {
    await page_navigate(ctx, ctx.startUrl);
    const f = await reDetectForm(ctx.page, form);
    if (!f) return "";
    await safeFill(f.usernameField, user);
    await safeFill(f.passwordField, password);
    await submitAndWait(ctx.page, f.submitButton, ctx.startUrl);
    return errorMessageFor(ctx.page);
  };

  const realLooking = ctx.testCredentials.username;
  const wrongPw = ctx.testCredentials.password + "-not-real";

  const messageReal = await messageFor(realLooking, wrongPw);
  const messageFake = await messageFor(NONEXISTENT_USERNAME, wrongPw);

  // Normalise whitespace before comparing.
  const a = messageReal.trim().replace(/\s+/g, " ");
  const b = messageFake.trim().replace(/\s+/g, " ");

  if (a && b && a !== b) {
    return {
      findings: [
        {
          attack: "username-enumeration",
          severity: severityIfMessageHelpful(a, b),
          url: ctx.startUrl,
          formType: "login",
          description:
            "Login error messages differ for valid-shaped vs definitely-invalid usernames — an attacker can enumerate existing accounts.",
          reference: REFS.usernameEnum,
          evidence: {
            realUsernameMessage: a.slice(0, 240),
            fakeUsernameMessage: b.slice(0, 240),
          },
        },
      ],
    };
  }
  return { findings: [] };
}

function severityIfMessageHelpful(a: string, b: string): AuthFindingSeverity {
  // If one message names the field ("user not found" vs "wrong password"),
  // the attacker has a turn-key oracle — that's high. Otherwise the
  // mere presence of any difference is medium.
  const helpful = /user|account|email/i.test(a) || /user|account|email/i.test(b);
  return helpful ? "high" : "medium";
}

async function errorMessageFor(page: Page): Promise<string> {
  // Common error locations: [role=alert], .error, [data-test=error],
  // [aria-live=assertive]. Take the first that has text.
  const selectors = [
    '[role="alert"]:visible',
    '[aria-live="assertive"]:visible',
    '[data-test*="error"]:visible',
    ".error:visible",
    ".form-error:visible",
    ".alert-danger:visible",
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const count = await loc.count();
    if (count === 0) continue;
    const text = (await loc.textContent({ timeout: 300 }).catch(() => "")) ?? "";
    if (text.trim()) return text;
  }
  // Fallback: any visible text added since submission (heuristic — take
  // body text, cap at 500 chars).
  const body = await page.locator("body").innerText({ timeout: 500 }).catch(() => "");
  return body.slice(0, 500);
}

// -------- sqli-credentials --------

async function attackSqliCredentials(
  form: DetectedAuthForm,
  ctx: AttackContext,
): Promise<AttackResult> {
  if (form.type !== "login") return { findings: [] };
  const findings: AuthFinding[] = [];
  for (const payload of SQLI_AUTH_BYPASS_PAYLOADS) {
    await page_navigate(ctx, ctx.startUrl);
    const f = await reDetectForm(ctx.page, form);
    if (!f) break;
    await safeFill(f.usernameField, payload);
    await safeFill(f.passwordField, "x");
    const submittedAt = Date.now();
    const responseTexts: string[] = [];
    const captureResponse = async (resp: import("playwright").Response): Promise<void> => {
      if (resp.request().resourceType() !== "document" && resp.request().resourceType() !== "xhr" && resp.request().resourceType() !== "fetch") return;
      const ct = resp.headers()["content-type"] ?? "";
      if (!ct.includes("text")) return;
      try {
        const body = await resp.text();
        responseTexts.push(body.slice(0, 4000));
      } catch {
        // ignore
      }
    };
    ctx.page.on("response", captureResponse);
    try {
      const navigated = await submitAndWait(ctx.page, f.submitButton, ctx.startUrl);
      const url = ctx.page.url();
      const bypassed = navigated && !sameAuthUrl(url, ctx.startUrl);
      const errorMatched = matchSqlErrors([...responseTexts, await ctx.page.content().catch(() => "")]);

      if (bypassed) {
        findings.push({
          attack: "sqli-credentials",
          severity: "critical",
          url: ctx.startUrl,
          formType: "login",
          description: `SQLi payload "${payload}" bypassed authentication — submitted as username, password did not match any user, yet the user was redirected away from the login page.`,
          reference: REFS.sqli,
          evidence: { payload, postSubmitUrl: url, elapsedMs: Date.now() - submittedAt },
        });
        break; // one confirmed bypass is enough
      }
      if (errorMatched) {
        findings.push({
          attack: "sqli-credentials",
          severity: "high",
          url: ctx.startUrl,
          formType: "login",
          description: `SQLi payload "${payload}" elicited a database error in the response body. Raw input is reaching the database driver.`,
          reference: REFS.sqli,
          evidence: { payload, errorPattern: errorMatched },
        });
        // keep going — different payloads may reveal more issues
      }
    } finally {
      ctx.page.off("response", captureResponse);
    }
  }
  return { findings };
}

function matchSqlErrors(bodies: ReadonlyArray<string>): string | null {
  for (const body of bodies) {
    if (!body) continue;
    for (const re of SQL_ERROR_SIGNATURES) {
      if (re.test(body)) return re.source;
    }
  }
  return null;
}

function sameAuthUrl(a: string, b: string): boolean {
  try {
    const pa = new URL(a).pathname;
    const pb = new URL(b).pathname;
    return pa === pb;
  } catch {
    return a === b;
  }
}

// -------- xss-credentials --------

async function attackXssCredentials(
  form: DetectedAuthForm,
  ctx: AttackContext,
): Promise<AttackResult> {
  const findings: AuthFinding[] = [];
  for (const payload of XSS_CREDENTIAL_PAYLOADS) {
    await page_navigate(ctx, ctx.startUrl);
    const f = await reDetectForm(ctx.page, form);
    if (!f) break;
    // Inject in whichever field is most likely to be displayed back
    // to the user. For signup, the username/name field is the prime
    // target; for login, the username field (some apps echo it on
    // failure).
    const target = f.usernameField;
    await target.fill(payload, { timeout: 2000 }).catch(() => {});
    await safeFill(f.passwordField, "ChaosTest123!");
    if (f.confirmPasswordField) await safeFill(f.confirmPasswordField, "ChaosTest123!");
    if (f.emailField && f.emailField !== target) await safeFill(f.emailField, freshTestEmail("xss"));

    await submitAndWait(ctx.page, f.submitButton, ctx.startUrl);
    const fired = await ctx.page.evaluate((marker) => Boolean((window as unknown as Record<string, unknown>)[marker]), XSS_AUTH_MARKER).catch(() => false);
    const reflected = await responseReflectsPayload(ctx.page, payload);

    if (fired) {
      findings.push({
        attack: "xss-credentials",
        severity: "critical",
        url: ctx.startUrl,
        formType: form.type,
        description: `XSS payload submitted via the username/name field executed in the rendered response — stored or reflected XSS at the auth boundary.`,
        reference: REFS.xss,
        evidence: { payload },
      });
      break;
    } else if (reflected) {
      findings.push({
        attack: "xss-credentials",
        severity: "medium",
        url: ctx.startUrl,
        formType: form.type,
        description: `Submitted markup was reflected in the response page without escaping; an attacker-controlled payload could land here.`,
        reference: REFS.xss,
        evidence: { payload, reflectedSnippet: reflected.slice(0, 200) },
      });
    }
  }
  return { findings };
}

async function responseReflectsPayload(page: Page, payload: string): Promise<string | null> {
  const html = await page.content().catch(() => "");
  if (!html) return null;
  // Match the verbatim payload OR the dangerous half (e.g. the
  // `onerror=` handler shape) — many apps half-escape and miss the
  // event handler.
  const fragments = [payload, payload.replace(/^[^<]*</, "<").replace(/>.*/, ">")];
  for (const f of fragments) {
    if (f.length < 5) continue;
    if (html.includes(f)) return f;
  }
  return null;
}

// -------- rate-limit-login --------

async function attackRateLimit(
  form: DetectedAuthForm,
  ctx: AttackContext,
): Promise<AttackResult> {
  if (form.type !== "login") return { findings: [] };
  const attempts = 8;
  const statusCounts: Record<number, number> = {};
  let blocked = false;
  let slowedDownAtAttempt: number | null = null;
  const baselineMs: number[] = [];

  for (let i = 0; i < attempts; i++) {
    await page_navigate(ctx, ctx.startUrl);
    const f = await reDetectForm(ctx.page, form);
    if (!f) break;
    await safeFill(f.usernameField, `wrong-${i}@example.invalid`);
    await safeFill(f.passwordField, `wrong-${i}-pw`);
    const responses: { status: number }[] = [];
    const listener = (resp: import("playwright").Response): void => {
      const t = resp.request().resourceType();
      if (t !== "document" && t !== "xhr" && t !== "fetch") return;
      responses.push({ status: resp.status() });
    };
    ctx.page.on("response", listener);
    const start = Date.now();
    try {
      await submitAndWait(ctx.page, f.submitButton, ctx.startUrl);
    } finally {
      ctx.page.off("response", listener);
    }
    const elapsed = Date.now() - start;
    if (i < 3) baselineMs.push(elapsed);
    else if (slowedDownAtAttempt === null && baselineMs.length > 0) {
      const baseAvg = baselineMs.reduce((a, b) => a + b, 0) / baselineMs.length;
      if (elapsed > baseAvg * 3 && elapsed > 500) slowedDownAtAttempt = i;
    }
    for (const r of responses) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      if (r.status === 429 || r.status === 423) blocked = true;
    }
  }

  if (blocked || slowedDownAtAttempt !== null) {
    // Defence detected — emit an `info` finding so it shows up but
    // doesn't fail anything.
    return {
      findings: [
        {
          attack: "rate-limit-login",
          severity: "info",
          url: ctx.startUrl,
          formType: "login",
          description: blocked
            ? "Server returned a rate-limit / lockout status during the burst (good)."
            : `Response time increased starting at attempt #${slowedDownAtAttempt} (consistent with rate limiting).`,
          reference: REFS.rateLimit,
          evidence: { statusCounts, baselineMs, attempts },
        },
      ],
    };
  }

  return {
    findings: [
      {
        attack: "rate-limit-login",
        severity: "medium",
        url: ctx.startUrl,
        formType: "login",
        description: `${attempts} consecutive failed login attempts produced no 429/423 and no observable slowdown. Without rate limiting an attacker can credential-stuff freely.`,
        reference: REFS.rateLimit,
        evidence: { statusCounts, baselineMs, attempts },
      },
    ],
  };
}

// -------- shared helpers --------

async function page_navigate(ctx: AttackContext, url: string): Promise<void> {
  await ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
}

async function reDetectForm(
  page: Page,
  hint: DetectedAuthForm,
): Promise<DetectedAuthForm | null> {
  // Re-resolve the form after a navigation. The previous Locator
  // references may be detached. We import lazily to avoid a circular
  // module loop.
  const { detectAuthForm } = await import("./detect.js");
  const re = await detectAuthForm(page);
  return re && re.type === hint.type ? re : re;
}

async function safeFill(loc: import("playwright").Locator, value: string): Promise<void> {
  await loc.fill(value, { timeout: 2000 }).catch(() => {});
}

async function submitAndWait(
  page: Page,
  submit: import("playwright").Locator,
  startUrl: string,
): Promise<boolean> {
  const before = page.url();
  await submit.click({ timeout: 2000 }).catch(() => {});
  // Wait for either a navigation OR a network-idle pause. We cap at
  // 2s so a hung server doesn't stall an attack burst.
  await page
    .waitForLoadState("networkidle", { timeout: 2000 })
    .catch(() => {});
  return page.url() !== before && page.url() !== startUrl;
}
