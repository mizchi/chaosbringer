/**
 * OWASP-aligned attack driver for login / signup forms. Detects the
 * auth form on a page (heuristic: `input[type=password]` + a sibling
 * username/email input + a submit button), then runs the configured
 * attack scenarios against it. Findings are emitted via
 * `onFinding` and stored on the driver (`getFindings()`).
 *
 * Authorisation reminder: only use against applications you are
 * authorised to test. The driver fires SQLi / XSS payloads, submits
 * weak passwords, and bursts login attempts — exactly the noise an
 * IDS / WAF would flag in production.
 */
export { authAttackDriver, type AuthAttackDriver } from "./driver.js";
export { detectAuthForm } from "./detect.js";
export {
  NONEXISTENT_USERNAME,
  SQLI_AUTH_BYPASS_PAYLOADS,
  SQL_ERROR_SIGNATURES,
  WEAK_PASSWORDS,
  XSS_AUTH_MARKER,
  XSS_CREDENTIAL_PAYLOADS,
  freshTestEmail,
} from "./payloads.js";
export type {
  AuthAttackName,
  AuthAttackOptions,
  AuthFinding,
  AuthFindingSeverity,
  AuthFormType,
  DetectedAuthForm,
} from "./types.js";
