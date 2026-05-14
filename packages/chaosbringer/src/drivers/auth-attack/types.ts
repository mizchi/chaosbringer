/**
 * Public types for the auth-attack driver.
 *
 * Driver scope: log in / sign up forms only. Each `AuthAttackName`
 * maps to an OWASP-referenced check the driver runs once the page's
 * auth form is detected. Findings are emitted via callback; they are
 * also (when severity ≥ "medium") thrown as `pageerror` so they
 * surface in chaosbringer's standard error report.
 *
 * Authorisation reminder: this driver fires malicious-looking inputs
 * (SQLi/XSS payloads, weak passwords, rate-limit probes). USE ONLY
 * AGAINST YOUR OWN APPLICATIONS in dev/staging environments. The
 * `chaos()` crawler's external-URL guard prevents accidental traffic
 * to third-party hosts, but you still own the responsibility.
 */
import type { Locator } from "playwright";

export type AuthAttackName =
  | "weak-password-signup"
  | "username-enumeration"
  | "sqli-credentials"
  | "xss-credentials"
  | "rate-limit-login";

export type AuthFormType = "login" | "signup";

export type AuthFindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface AuthFinding {
  attack: AuthAttackName;
  severity: AuthFindingSeverity;
  /** Page URL where the form was detected. */
  url: string;
  /** Form type that was attacked. */
  formType: AuthFormType;
  /** One-line summary. */
  description: string;
  /** OWASP / WSTG reference identifier. */
  reference: string;
  /** Free-form structured evidence (response excerpts, timings, etc.). */
  evidence?: Record<string, unknown>;
}

export interface DetectedAuthForm {
  type: AuthFormType;
  /** The form root (or a synthetic ancestor for formless layouts). */
  form: Locator;
  /** First username / email input found. May be the same locator as `emailField`. */
  usernameField: Locator;
  /** Password input. Required — detection fails if absent. */
  passwordField: Locator;
  /** Optional confirm-password input (signup forms). */
  confirmPasswordField?: Locator;
  /** Optional dedicated email input separate from the username field. */
  emailField?: Locator;
  /** Submit affordance — `button[type=submit]` or `input[type=submit]`. */
  submitButton: Locator;
}

export interface AuthAttackOptions {
  /**
   * Subset of attacks to run. Default: all built-ins.
   *
   * Set this to a narrow list when iterating on the driver — running
   * everything bursts ~30 form submissions per detected page.
   */
  attacks?: ReadonlyArray<AuthAttackName>;
  /**
   * Override the heuristic form detector. Return `null` if the page
   * is not an auth page. The default detector matches forms with
   * `input[type=password]` + a sibling text/email input + a submit
   * affordance; URL hints (`/login`, `/signup`, etc.) decide
   * login-vs-signup when both could fit.
   */
  detectForm?: (
    page: import("playwright").Page,
  ) => Promise<DetectedAuthForm | null>;
  /** Called for every finding the driver produces (real-time stream). */
  onFinding?: (finding: AuthFinding) => void | Promise<void>;
  /**
   * Throw a `pageerror`-equivalent for any finding at or above this
   * severity, so it lands in `report.errorClusters`. Default:
   * `"medium"`. Set to `"critical"` to never surface as errors.
   */
  errorAtSeverity?: AuthFindingSeverity;
  /**
   * Test credentials for attacks that need a valid-ish username
   * (username enumeration). Defaults to a synthetic
   * `chaosbringer-test@example.invalid` shape that should not exist
   * but will not collide with real users either.
   */
  testCredentials?: { username: string; password: string };
  /**
   * Limit how often the driver re-attacks the same URL. Default: 1.
   * The crawler may visit the same auth page multiple times; we don't
   * want a 6× burst.
   */
  maxAttacksPerUrl?: number;
  /** Verbose log on `console.log`. Default: false. */
  verbose?: boolean;
}
