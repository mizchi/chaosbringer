/**
 * Named fault profiles. Each profile is a small function that returns an
 * array of FaultRule, expressing operator knowledge ("S3 is bursty",
 * "the auth service is slow") that would otherwise live as ad-hoc
 * probability numbers in every consumer's chaos config.
 *
 * Profiles are intentionally simple to compose:
 *
 *   import { chaos, profiles } from "chaosbringer";
 *
 *   await chaos({
 *     baseUrl: "http://localhost:3000",
 *     faultInjection: [
 *       ...profiles.flakyThirdPartyCdn(/cdn\.example\.com/),
 *       ...profiles.s3FivexxBurst(/s3\.amazonaws\.com/),
 *     ],
 *   });
 *
 * The numeric knobs in each profile are starting points based on what the
 * lab has seen produce useful failures. Override anything by passing a
 * second `options` argument; consumers who need a wholly different shape
 * should compose `faults.*` directly instead.
 */

import { faults, type FaultHelperOptions } from "@mizchi/playwright-faults";
import type { FaultRule, UrlMatcher } from "@mizchi/playwright-faults";

/**
 * Third-party CDN that is intermittently slow and occasionally drops a
 * request. Conservative defaults — a chaos run with this profile should
 * still let most pages through.
 */
function flakyThirdPartyCdn(urlPattern: UrlMatcher): FaultRule[] {
  return [
    faults.delay(2000, { urlPattern, probability: 0.3, name: "flaky-third-party-cdn:slow" }),
    faults.abort({ urlPattern, probability: 0.05, name: "flaky-third-party-cdn:drop" }),
  ];
}

/**
 * Object-storage 5xx burst (S3-style). Mostly 503 (rate-limit / partition),
 * occasional 500. Targets the kind of error pattern that causes
 * exponential-backoff retry storms.
 */
function s3FivexxBurst(urlPattern: UrlMatcher): FaultRule[] {
  return [
    faults.status(503, { urlPattern, probability: 0.4, name: "s3-burst:503" }),
    faults.status(500, { urlPattern, probability: 0.05, name: "s3-burst:500" }),
  ];
}

/**
 * "A region of the dependency graph is partially degraded." Severity 0..1
 * scales every knob proportionally — 0.3 is the suggested default.
 */
function regionalDegradation(opts: {
  urlPattern: UrlMatcher;
  severity?: number;
}): FaultRule[] {
  const s = clamp01(opts.severity ?? 0.3);
  return [
    faults.delay(1500, { urlPattern: opts.urlPattern, probability: s * 0.7, name: "regional-degradation:slow" }),
    faults.status(500, { urlPattern: opts.urlPattern, probability: s * 0.2, name: "regional-degradation:5xx" }),
    faults.abort({ urlPattern: opts.urlPattern, probability: s * 0.1, name: "regional-degradation:drop" }),
  ];
}

/**
 * Single-dependency latency. Useful for testing that a slow auth
 * service doesn't block first-paint or stall every page.
 */
function slowAuthService(urlPattern: UrlMatcher, opts?: { ms?: number; rate?: number }): FaultRule[] {
  const ms = opts?.ms ?? 3000;
  const rate = clamp01(opts?.rate ?? 0.5);
  return [faults.delay(ms, { urlPattern, probability: rate, name: "slow-auth-service" })];
}

/**
 * Mix of clean truncated bodies (200 with empty body) and outright errors.
 * Catches consumers that crash on JSON.parse("") or assume a non-empty
 * body on 200.
 */
function partialDataLoss(urlPattern: UrlMatcher, opts?: { rate?: number }): FaultRule[] {
  const rate = clamp01(opts?.rate ?? 0.2);
  return [
    faults.status(200, {
      urlPattern,
      probability: rate * 0.6,
      body: "",
      contentType: "application/json",
      name: "partial-data-loss:empty-200",
    }),
    faults.status(500, { urlPattern, probability: rate * 0.4, name: "partial-data-loss:5xx" }),
  ];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export const profiles = {
  flakyThirdPartyCdn,
  s3FivexxBurst,
  regionalDegradation,
  slowAuthService,
  partialDataLoss,
};

// Suppress unused-import warning for FaultHelperOptions; re-exported for
// callers that want to write their own profile in the same shape.
export type { FaultHelperOptions };
