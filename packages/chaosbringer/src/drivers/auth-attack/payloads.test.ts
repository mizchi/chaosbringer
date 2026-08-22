import { describe, expect, it, vi } from "vitest";
import {
  freshTestEmail,
  NONEXISTENT_USERNAME,
  SQLI_AUTH_BYPASS_PAYLOADS,
  SQL_ERROR_SIGNATURES,
  WEAK_PASSWORDS,
  XSS_AUTH_MARKER,
  XSS_CREDENTIAL_PAYLOADS,
} from "./payloads.js";

describe("auth-attack payloads", () => {
  it("WEAK_PASSWORDS contains canonical worst-of entries (NIST 800-63B check basis)", () => {
    expect(WEAK_PASSWORDS).toContain("password");
    expect(WEAK_PASSWORDS).toContain("12345678");
    // ASVS implies minimum length 8 — every weak example should be ≥ 8 chars
    // so we never falsely test "rejected for being too short".
    for (const pw of WEAK_PASSWORDS) {
      expect(pw.length).toBeGreaterThanOrEqual(8);
    }
  });

  it("SQLI_AUTH_BYPASS_PAYLOADS focuses on auth-bypass shapes (no UNION exfil)", () => {
    expect(SQLI_AUTH_BYPASS_PAYLOADS.length).toBeGreaterThan(0);
    for (const p of SQLI_AUTH_BYPASS_PAYLOADS) {
      expect(p).toMatch(/(or\s+['"]?1['"]?\s*=|admin'|--)/i);
      expect(p.toUpperCase()).not.toContain("UNION SELECT");
    }
  });

  it("XSS_CREDENTIAL_PAYLOADS write to the marker (no dialog-driven probes)", () => {
    for (const p of XSS_CREDENTIAL_PAYLOADS) {
      expect(p).toContain(`window.${XSS_AUTH_MARKER}`);
    }
  });

  it("NONEXISTENT_USERNAME uses the RFC 2606 .invalid TLD", () => {
    expect(NONEXISTENT_USERNAME).toMatch(/\.invalid$/);
  });

  it("freshTestEmail produces unique addresses across calls", () => {
    // 20000, not 50. The old implementation leaned on 16 bits of randomness
    // inside a constant millisecond, so 50 calls collided in 1.68% of trials —
    // a test that failed once every sixty CI runs and passed the rest, which
    // reads as a flake rather than as the bug it was. At this scale the old
    // implementation loses ~200 addresses every time, so the test either
    // catches the defect or it is not there.
    //
    // The addresses are what the auth-attack probes sign up with: a collision
    // makes a probe register an address that already exists and report the
    // app's duplicate-signup behaviour as its answer about a fresh signup.
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(freshTestEmail());
    expect(seen.size).toBe(20000);
  });

  it("is unique by construction, not by having enough random bits", () => {
    // Freeze *both* sources of entropy. Any implementation whose uniqueness
    // comes from a timestamp or from randomness produces 1 distinct address
    // here; only a counter produces 200. That is the difference between a
    // guarantee and a wide-enough coincidence, and a statistical test cannot
    // tell them apart — widening `Math.random()` to 32 bits passes a
    // 20000-draw uniqueness check ~95% of the time while still being able to
    // collide.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(freshTestEmail());
      expect(seen.size).toBe(200);
    } finally {
      nowSpy.mockRestore();
      randSpy.mockRestore();
    }
  });

  it("freshTestEmail with a salt embeds it as a plus-tag", () => {
    const e = freshTestEmail("xss");
    expect(e).toContain("+xss");
    expect(e).toMatch(/@example\.invalid$/);
  });

  it("SQL_ERROR_SIGNATURES catches common vendor errors", () => {
    const samples = [
      "Error: SQL syntax error near 'OR'",
      "SQLSTATE[42000]: Syntax error",
      "ORA-00933: SQL command not properly ended",
      "PG::SyntaxError: ERROR:  syntax error at end of input",
    ];
    for (const s of samples) {
      const matched = SQL_ERROR_SIGNATURES.some((re) => re.test(s));
      expect(matched, `expected ${s} to match a signature`).toBe(true);
    }
  });

  it("SQL_ERROR_SIGNATURES does not match benign copy", () => {
    const safe = [
      "Please review the syntax of your search.",
      "Welcome back. Your session expired.",
    ];
    for (const s of safe) {
      const matched = SQL_ERROR_SIGNATURES.some((re) => re.test(s));
      expect(matched, `expected ${s} NOT to match`).toBe(false);
    }
  });
});
