/**
 * The integration's oracle: one function that says whether a scenario did
 * what the issue's first example asks for.
 *
 * A Kitesurf page that ends up showing `ok:3` proves little on its own: a
 * rule whose URL never matched produces the same DOM with no fault at all.
 * So the page result is judged together with the session's per-rule stats
 * and with how often the real (fixture) server was called. The broken
 * fixture and the misspelt-URL rule both fail here, each for its own reason,
 * and the runner checks that the reason is the expected one.
 *
 * Pure: no I/O, so it runs as a unit test without Kitesurf.
 */

import type { FaultInjectionStats } from "@mizchi/kitesurf-faults";

export type OracleReasonCode =
  /** stats or upstream counts could not be collected, or lack an expected rule. */
  | "stats-missing"
  /** Every expected injection is missing: the fault never fired. */
  | "not-injected"
  /** A rule's matched / injected / suppressed differ from the expectation. */
  | "stats-mismatch"
  /** The fixture server saw a path a different number of times. */
  | "upstream-count-mismatch"
  /** The page's final DOM differs. */
  | "dom-mismatch";

export interface OracleReason {
  code: OracleReasonCode;
  detail: string;
}

export interface OracleResult {
  ok: boolean;
  reasons: OracleReason[];
}

/** Text of the elements the scenario reads, `null` when the element is absent. */
export type DomSnapshot = Record<string, string | null | undefined>;

export interface OracleExpect {
  dom: Record<string, string>;
  /** Only the rules named here are checked; `suppressed` only when given. */
  stats: FaultInjectionStats[];
  /** Only the paths named here are checked; a path never called counts as 0. */
  upstream: Record<string, number>;
}

export interface OracleInput {
  dom: DomSnapshot;
  stats: FaultInjectionStats[] | undefined;
  upstream: Record<string, number> | undefined;
  expect: OracleExpect;
}

export function evaluate(input: OracleInput): OracleResult {
  const reasons: OracleReason[] = [];
  const { expect } = input;

  for (const [key, want] of Object.entries(expect.dom)) {
    const got = input.dom[key];
    if (got !== want) {
      reasons.push({ code: "dom-mismatch", detail: `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got ?? null)}` });
    }
  }

  // Missing numbers are a failure of their own, never read as zero: a run
  // whose stats were lost would otherwise pass any "nothing happened" check.
  const missing: string[] = [];
  if (!input.stats) missing.push("stats");
  if (!input.upstream) missing.push("upstream counts");
  if (input.stats) {
    for (const want of expect.stats) {
      if (!input.stats.some((s) => s.rule === want.rule)) missing.push(`stats for rule ${want.rule}`);
    }
  }
  if (missing.length > 0) reasons.push({ code: "stats-missing", detail: `missing ${missing.join(", ")}` });

  if (input.stats) {
    const wantInjected = expect.stats.reduce((n, s) => n + s.injected, 0);
    const present = expect.stats.flatMap((want) => input.stats!.filter((s) => s.rule === want.rule));
    const gotInjected = present.reduce((n, s) => n + s.injected, 0);
    if (wantInjected > 0 && present.length > 0 && gotInjected === 0) {
      reasons.push({ code: "not-injected", detail: `expected ${wantInjected} injection(s), the session injected none` });
    }
    for (const want of expect.stats) {
      const got = input.stats.find((s) => s.rule === want.rule);
      if (!got) continue;
      const diffs: string[] = [];
      if (got.matched !== want.matched) diffs.push(`matched ${got.matched} (expected ${want.matched})`);
      if (got.injected !== want.injected) diffs.push(`injected ${got.injected} (expected ${want.injected})`);
      if (want.suppressed !== undefined && (got.suppressed ?? 0) !== want.suppressed) {
        diffs.push(`suppressed ${got.suppressed ?? 0} (expected ${want.suppressed})`);
      }
      if (diffs.length > 0) reasons.push({ code: "stats-mismatch", detail: `${want.rule}: ${diffs.join(", ")}` });
    }
  }

  if (input.upstream) {
    for (const [path, want] of Object.entries(expect.upstream)) {
      const got = input.upstream[path] ?? 0;
      if (got !== want) reasons.push({ code: "upstream-count-mismatch", detail: `${path}: expected ${want}, got ${got}` });
    }
  }

  return { ok: reasons.length === 0, reasons };
}
