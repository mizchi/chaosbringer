/**
 * Up-front validation of caller-supplied options, so everything downstream can
 * assume well-formed inputs and no user ever meets an anonymous
 * `TypeError: Invalid URL`.
 *
 * Every message starts with `chaosbringer:` and names the field it is about.
 */
import { BUDGET_METRIC } from "lightbringer/core";
import { devices } from "playwright";
import { validateFaultSchedule } from "./schedule.js";
import { NETWORK_PROFILES, PERF_BUDGET_KEYS } from "./types.js";
import type { CrawlerOptions, UrlMatcher } from "./types.js";
import { cdpEndpointUrl } from "./cdp.js";
import { validateSettle } from "./settle.js";
import { validatePerf } from "./perf-options.js";

/**
 * Validate user-supplied options up front so downstream code can assume
 * well-formed inputs. Every error starts with `chaosbringer:` and names
 * the field, so users don't get an anonymous `TypeError: Invalid URL`.
 */
/**
 * Option names the type system cannot protect a caller from getting wrong.
 *
 * `CrawlerOptions` is a closed type, but excess-property checking only applies
 * to a fresh object literal — spread one, build it in a helper, or write plain
 * JS, and `maxActions: 0` sails through and does nothing. Measured on the
 * fixture page: 4 chaos actions with the default, 0 with
 * `maxActionsPerPage: 0`, and 4 with `maxActions: 0`, which is the shape of
 * "my fault never fired and I cannot see why". This file's own tests did it.
 *
 * Only *near misses* are refused. A key nobody could have meant as an option —
 * a caller's own `myAppPort` riding along in a config object — is left alone,
 * because breaking those to catch typos would trade one silent failure for a
 * loud one somebody did not ask for.
 */
export const KNOWN_OPTION_NAMES = [
  "baseUrl", "maxPages", "maxActionsPerPage", "timeout", "headless", "screenshots",
  "screenshotDir", "excludePatterns", "ignoreErrorPatterns", "spaPatterns", "viewport",
  "userAgent", "traceparent", "actionWeights", "logFile", "logLevel", "logToConsole",
  "enableRecovery", "recoveryHistorySize", "seed", "invariants", "faultInjection",
  "lifecycleFaults", "runtimeFaults", "iframeFaults", "launchOptions", "har",
  "storageState", "performanceBudget", "traceOut", "traceReplay", "device", "network",
  "seedFromSitemap", "advisor", "driver", "driverGoal", "coverageFeedback",
  "shardIndex", "shardCount", "blockExternalNavigation", "failureArtifacts", "server",
  "initScripts", "perf", "perfBudgets", "perfBudgetsFile", "cdpEndpoint", "cdpTargetId",
  "terminalBrowser", "settle", "httpCache",
] as const;

/**
 * Compile-time guard that the list above is complete.
 *
 * A list like this rots silently in the worst possible direction: add an option
 * and forget it here, and the near-miss check refuses the *correct* new name as
 * a typo of an old one. If this line fails to compile, the error names the
 * options that are missing from `KNOWN_OPTION_NAMES` — add them.
 */
type UnlistedOptionNames = Exclude<keyof CrawlerOptions, (typeof KNOWN_OPTION_NAMES)[number]>;
const _allOptionsListed: UnlistedOptionNames extends never ? true : UnlistedOptionNames = true;
void _allOptionsListed;

/** Levenshtein distance, capped: we only care whether it is 1 or 2. */
function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

function rejectNearMissOptions(options: object): void {
  const known: ReadonlySet<string> = new Set<string>(KNOWN_OPTION_NAMES);
  for (const key of Object.keys(options)) {
    if (known.has(key)) continue;
    const lower = key.toLowerCase();
    // Rank rather than take the first hit: in list order, `shard` matched
    // `har` (two edits) before `shardIndex` (a prefix), and a suggestion that
    // makes no sense is worse than none. Prefix relationships win, then the
    // smaller edit distance.
    let suggestion: string | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const name of KNOWN_OPTION_NAMES as readonly string[]) {
      const n = name.toLowerCase();
      // A prefix of a real name (`maxActions` for `maxActionsPerPage`), or a
      // plural/singular slip (`faultInjections` for `faultInjection`).
      const prefix = (n.startsWith(lower) || lower.startsWith(n)) && Math.min(n.length, lower.length) >= 4;
      const distance = editDistance(lower, n, 2);
      const score = prefix ? 0 : distance <= 2 ? distance : Number.POSITIVE_INFINITY;
      if (score < best) {
        best = score;
        suggestion = name;
      }
    }
    if (suggestion !== undefined) {
      throw new Error(
        `chaosbringer: unknown option "${key}" — did you mean "${suggestion}"? ` +
          `A misspelled option is accepted and ignored by JavaScript, so it fails as ` +
          `"my fault never fired" rather than as an error.`,
      );
    }
  }
}

export function validateOptions(options: CrawlerOptions): void {
  rejectNearMissOptions(options);
  if (options.terminalBrowser && options.cdpEndpoint !== undefined) {
    throw new Error('chaosbringer: "terminalBrowser" cannot be used with "cdpEndpoint"');
  }
  if (options.terminalBrowser && options.cdpTargetId !== undefined) {
    throw new Error('chaosbringer: "terminalBrowser" cannot be used with "cdpTargetId"');
  }
  if (options.cdpTargetId && !options.cdpEndpoint) {
    throw new Error('chaosbringer: "cdpTargetId" requires "cdpEndpoint"');
  }
  if (options.cdpTargetId !== undefined && !options.cdpTargetId.trim()) {
    throw new Error('chaosbringer: "cdpTargetId" must not be empty');
  }
  if (options.cdpEndpoint !== undefined || options.terminalBrowser) {
    if (options.cdpEndpoint !== undefined) cdpEndpointUrl(options.cdpEndpoint);
    for (const key of ["launchOptions", "device", "viewport", "userAgent", "storageState"] as const) {
      if (options[key] !== undefined) {
        throw new Error(`chaosbringer: "${key}" cannot be used with an attached browser`);
      }
    }
    if (options.har) {
      throw new Error('chaosbringer: HAR cannot be used with an attached browser');
    }
  }
  // baseUrl — parse and surface a named error.
  try {
    // eslint-disable-next-line no-new
    new URL(options.baseUrl);
  } catch {
    throw new Error(
      `chaosbringer: "baseUrl" must be an absolute URL (got ${JSON.stringify(options.baseUrl)})`
    );
  }

  const requirePositive = (name: string, value: number | undefined, min: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
      throw new Error(
        `chaosbringer: "${name}" must be an integer >= ${min} (got ${JSON.stringify(value)})`
      );
    }
  };
  requirePositive("maxPages", options.maxPages, 1);
  requirePositive("maxActionsPerPage", options.maxActionsPerPage, 0);
  requirePositive("timeout", options.timeout, 1);
  requirePositive("recoveryHistorySize", options.recoveryHistorySize, 0);
  validateSettle(options.settle);

  if (options.shardIndex !== undefined || options.shardCount !== undefined) {
    if (options.shardCount === undefined || options.shardIndex === undefined) {
      throw new Error(
        `chaosbringer: "shardIndex" and "shardCount" must be set together`
      );
    }
    if (
      !Number.isInteger(options.shardCount) ||
      options.shardCount < 1
    ) {
      throw new Error(
        `chaosbringer: "shardCount" must be an integer >= 1 (got ${JSON.stringify(options.shardCount)})`
      );
    }
    if (
      !Number.isInteger(options.shardIndex) ||
      options.shardIndex < 0 ||
      options.shardIndex >= options.shardCount
    ) {
      throw new Error(
        `chaosbringer: "shardIndex" must be an integer in [0, ${options.shardCount}) (got ${JSON.stringify(options.shardIndex)})`
      );
    }
  }

  if (options.seed !== undefined) {
    if (!Number.isFinite(options.seed) || !Number.isInteger(options.seed) || options.seed < 0) {
      throw new Error(
        `chaosbringer: "seed" must be a non-negative integer (got ${JSON.stringify(options.seed)})`
      );
    }
  }

  const assertRegexString = (label: string, pattern: string | undefined): void => {
    if (pattern === undefined) return;
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch {
      throw new Error(`chaosbringer: ${label} has invalid regex: ${JSON.stringify(pattern)}`);
    }
  };

  const assertMatcher = (label: string, m: UrlMatcher | undefined): void => {
    if (m === undefined) return;
    if (m instanceof RegExp) return; // Already compiled, always valid.
    assertRegexString(label, m);
  };

  for (const p of options.excludePatterns ?? []) assertRegexString(`excludePatterns entry`, p);
  for (const p of options.ignoreErrorPatterns ?? []) assertRegexString(`ignoreErrorPatterns entry`, p);
  for (const p of options.spaPatterns ?? []) assertRegexString(`spaPatterns entry`, p);

  for (const [ruleIndex, rule] of (options.faultInjection ?? []).entries()) {
    // The index when there is no name: "faultInjection rule" alone, in a
    // config with twenty of them, does not tell you which one to fix.
    //
    // …and the pattern alongside it, because the two halves of this library
    // label the same unnamed rule differently: errors here said "rule #3"
    // while `getFaultStats` reports it as `pattern.toString()`. Each is the
    // right handle for its own context — the index finds it in your array, the
    // pattern finds it in the report — and carrying both is what lets a reader
    // connect an error to the row it is about.
    const label = rule.name
      ? `faultInjection rule "${rule.name}"`
      : `faultInjection rule #${ruleIndex} (${String(rule.urlPattern)})`;
    assertMatcher(`${label} urlPattern`, rule.urlPattern);
    validateFaultSchedule(label, rule, "chaosbringer");
    if (rule.probability !== undefined) {
      const p = rule.probability;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(
          `chaosbringer: ${label} probability must be in [0, 1] (got ${JSON.stringify(p)})`
        );
      }
    }
    if (rule.fault.kind === "hang" && rule.fault.releaseAfterMs !== undefined) {
      const ms = rule.fault.releaseAfterMs;
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(
          `chaosbringer: ${label} hang releaseAfterMs must be a non-negative finite number (got ${JSON.stringify(ms)})`
        );
      }
    }
  }

  const VALID_STAGES = new Set([
    "beforeNavigation",
    "afterLoad",
    "beforeActions",
    "betweenActions",
  ]);
  const VALID_SCOPES = new Set(["localStorage", "sessionStorage", "cookies", "indexedDB"]);
  for (const [faultIndex, fault] of (options.lifecycleFaults ?? []).entries()) {
    const label = fault.name
      ? `lifecycleFaults entry "${fault.name}"`
      : `lifecycleFaults entry #${faultIndex}`;
    if (!VALID_STAGES.has(fault.when)) {
      throw new Error(
        `chaosbringer: ${label} "when" must be one of beforeNavigation/afterLoad/beforeActions/betweenActions (got ${JSON.stringify(fault.when)})`
      );
    }
    assertMatcher(`${label} urlPattern`, fault.urlPattern);
    validateFaultSchedule(label, fault, "chaosbringer");
    if (fault.probability !== undefined) {
      const p = fault.probability;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(
          `chaosbringer: ${label} probability must be in [0, 1] (got ${JSON.stringify(p)})`
        );
      }
    }
    const a = fault.action;
    if (a.kind === "cpu-throttle") {
      if (!Number.isFinite(a.rate) || a.rate < 1) {
        throw new Error(
          `chaosbringer: ${label} cpu-throttle rate must be a finite number >= 1 (got ${JSON.stringify(a.rate)})`
        );
      }
    } else if (a.kind === "clear-storage") {
      if (!Array.isArray(a.scopes) || a.scopes.length === 0) {
        throw new Error(`chaosbringer: ${label} clear-storage requires at least one scope`);
      }
      for (const scope of a.scopes) {
        if (!VALID_SCOPES.has(scope)) {
          throw new Error(
            `chaosbringer: ${label} clear-storage scope must be one of localStorage/sessionStorage/cookies/indexedDB (got ${JSON.stringify(scope)})`
          );
        }
      }
    } else if (a.kind === "tamper-storage") {
      if (a.scope !== "localStorage" && a.scope !== "sessionStorage") {
        throw new Error(
          `chaosbringer: ${label} tamper-storage scope must be localStorage or sessionStorage (got ${JSON.stringify(a.scope)})`
        );
      }
      if (typeof a.key !== "string" || a.key.length === 0) {
        throw new Error(`chaosbringer: ${label} tamper-storage key must be a non-empty string`);
      }
      if (typeof a.value !== "string") {
        throw new Error(`chaosbringer: ${label} tamper-storage value must be a string`);
      }
    } else if (a.kind === "evict-cache") {
      if (a.cacheNames !== undefined && !Array.isArray(a.cacheNames)) {
        throw new Error(`chaosbringer: ${label} evict-cache cacheNames must be an array of strings`);
      }
    }
  }

  for (const [faultIndex, fault] of (options.runtimeFaults ?? []).entries()) {
    const label = fault.name
      ? `runtimeFaults entry "${fault.name}"`
      : `runtimeFaults entry #${faultIndex}`;
    assertMatcher(`${label} urlPattern`, fault.urlPattern);
    validateFaultSchedule(label, fault, "chaosbringer");
    if (fault.methods !== undefined) {
      if (!Array.isArray(fault.methods) || fault.methods.length === 0) {
        throw new Error(`chaosbringer: ${label} methods must be a non-empty array of HTTP methods`);
      }
      for (const m of fault.methods) {
        if (typeof m !== "string" || m.length === 0) {
          throw new Error(
            `chaosbringer: ${label} methods entry must be a non-empty string (got ${JSON.stringify(m)})`
          );
        }
      }
    }
    if (fault.probability !== undefined) {
      const p = fault.probability;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(
          `chaosbringer: ${label} probability must be in [0, 1] (got ${JSON.stringify(p)})`
        );
      }
    }
    const a = fault.action;
    const assertMessage = (kind: string, message: unknown): void => {
      if (message !== undefined && typeof message !== "string") {
        throw new Error(`chaosbringer: ${label} ${kind} rejectionMessage must be a string`);
      }
    };
    if (a.kind === "flaky-fetch") {
      assertMessage("flaky-fetch", a.rejectionMessage);
    } else if (a.kind === "reject-fetch") {
      assertMessage("reject-fetch", a.rejectionMessage);
      if (a.rejectAs !== undefined && a.rejectAs !== "TypeError" && a.rejectAs !== "AbortError") {
        throw new Error(
          `chaosbringer: ${label} reject-fetch rejectAs must be "TypeError" or "AbortError" (got ${JSON.stringify(a.rejectAs)})`
        );
      }
    } else if (a.kind === "never-settle-fetch") {
      // No fields to validate.
    } else if (a.kind === "resolve-rejected-thenable") {
      assertMessage("resolve-rejected-thenable", a.rejectionMessage);
    } else if (a.kind === "reject-body") {
      assertMessage("reject-body", a.rejectionMessage);
      const VALID_CONSUMERS = new Set(["json", "text", "arrayBuffer", "blob", "formData"]);
      if (a.consumers !== undefined) {
        if (!Array.isArray(a.consumers) || a.consumers.length === 0) {
          throw new Error(
            `chaosbringer: ${label} reject-body consumers must be a non-empty array`
          );
        }
        for (const c of a.consumers) {
          if (!VALID_CONSUMERS.has(c)) {
            throw new Error(
              `chaosbringer: ${label} reject-body consumers entry is not recognized (got ${JSON.stringify(c)})`
            );
          }
        }
      }
    } else if (a.kind === "clock-skew") {
      if (!Number.isFinite(a.skewMs) || !Number.isInteger(a.skewMs)) {
        throw new Error(
          `chaosbringer: ${label} clock-skew skewMs must be a finite integer (got ${JSON.stringify(a.skewMs)})`
        );
      }
      // `clock-skew` is page-scoped: it patches `Date` once when the init
      // script installs, matching on `location.href`. There is no request, so
      // there is no method to filter on — and a `methods` here was accepted
      // and then ignored, which reads as "the fault applies to POSTs only"
      // while it applies to the whole page.
      if (fault.methods !== undefined) {
        throw new Error(
          `chaosbringer: ${label} sets methods on a clock-skew action, which is page-scoped ` +
            `(it patches Date once per page load and matches location.href, so no request method ` +
            `is involved) — drop methods, or use urlPattern to scope it to a page`
        );
      }
    } else {
      throw new Error(
        `chaosbringer: ${label} action.kind is not recognized (got ${JSON.stringify((a as { kind: unknown }).kind)})`
      );
    }
  }

  for (const [faultIndex, fault] of (options.iframeFaults ?? []).entries()) {
    const label = fault.name
      ? `iframeFaults entry "${fault.name}"`
      : `iframeFaults entry #${faultIndex}`;
    if (typeof fault.selector !== "string" || fault.selector.length === 0) {
      throw new Error(`chaosbringer: ${label} selector must be a non-empty string`);
    }
    validateFaultSchedule(label, fault, "chaosbringer");
    if (fault.probability !== undefined) {
      const p = fault.probability;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(
          `chaosbringer: ${label} probability must be in [0, 1] (got ${JSON.stringify(p)})`
        );
      }
    }
    const a = fault.action;
    if (a.kind === "load-delay") {
      if (!Number.isFinite(a.ms) || a.ms < 0) {
        throw new Error(
          `chaosbringer: ${label} load-delay ms must be a non-negative finite number (got ${JSON.stringify(a.ms)})`
        );
      }
    } else if (a.kind === "never-load") {
      // No further fields to validate.
    } else if (a.kind === "remove-mid-load") {
      if (!Number.isFinite(a.atMs) || a.atMs < 0) {
        throw new Error(
          `chaosbringer: ${label} remove-mid-load atMs must be a non-negative finite number (got ${JSON.stringify(a.atMs)})`
        );
      }
    } else {
      throw new Error(
        `chaosbringer: ${label} action.kind is not recognized (got ${JSON.stringify((a as { kind: unknown }).kind)})`
      );
    }
  }

  for (const inv of options.invariants ?? []) {
    assertMatcher(`invariant "${inv.name}" urlPattern`, inv.urlPattern);
  }

  if (options.har) {
    const { path, mode } = options.har;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`chaosbringer: "har.path" must be a non-empty string`);
    }
    if (mode !== "record" && mode !== "replay") {
      throw new Error(
        `chaosbringer: "har.mode" must be "record" or "replay" (got ${JSON.stringify(mode)})`
      );
    }
  }

  if (options.storageState !== undefined) {
    if (typeof options.storageState !== "string" || options.storageState.length === 0) {
      throw new Error(
        `chaosbringer: "storageState" must be a non-empty path string (got ${JSON.stringify(options.storageState)})`
      );
    }
  }

  const assertNonEmptyStringOpt = (name: string, v: unknown): void => {
    if (v === undefined) return;
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`chaosbringer: "${name}" must be a non-empty path string (got ${JSON.stringify(v)})`);
    }
  };
  assertNonEmptyStringOpt("traceOut", options.traceOut);
  assertNonEmptyStringOpt("traceReplay", options.traceReplay);
  assertNonEmptyStringOpt("seedFromSitemap", options.seedFromSitemap);

  if (options.device !== undefined) {
    if (typeof options.device !== "string" || options.device.length === 0) {
      throw new Error(
        `chaosbringer: "device" must be a non-empty Playwright device name (got ${JSON.stringify(options.device)})`
      );
    }
    if (!devices[options.device]) {
      throw new Error(
        `chaosbringer: "device" ${JSON.stringify(options.device)} is not a known Playwright device descriptor`
      );
    }
  }

  if (options.network !== undefined) {
    const allowed = new Set<string>(NETWORK_PROFILES);
    if (typeof options.network !== "string" || !allowed.has(options.network)) {
      throw new Error(
        `chaosbringer: "network" must be one of ${NETWORK_PROFILES.join(", ")} (got ${JSON.stringify(options.network)})`
      );
    }
  }

  if (options.coverageFeedback !== undefined) {
    const cf = options.coverageFeedback;
    if (cf === null || typeof cf !== "object" || Array.isArray(cf)) {
      throw new Error(
        `chaosbringer: "coverageFeedback" must be an object with at least an "enabled" boolean`
      );
    }
    if (typeof cf.enabled !== "boolean") {
      throw new Error(`chaosbringer: "coverageFeedback.enabled" must be a boolean`);
    }
    if (cf.boost !== undefined) {
      if (typeof cf.boost !== "number" || !Number.isFinite(cf.boost) || cf.boost < 0) {
        throw new Error(
          `chaosbringer: "coverageFeedback.boost" must be a non-negative finite number (got ${JSON.stringify(cf.boost)})`
        );
      }
    }
    if (cf.topN !== undefined) {
      if (!Number.isInteger(cf.topN) || cf.topN < 0) {
        throw new Error(
          `chaosbringer: "coverageFeedback.topN" must be a non-negative integer (got ${JSON.stringify(cf.topN)})`
        );
      }
    }
  }

  if (options.failureArtifacts !== undefined) {
    const fa = options.failureArtifacts;
    if (fa === null || typeof fa !== "object" || Array.isArray(fa)) {
      throw new Error(
        `chaosbringer: "failureArtifacts" must be an object with a "dir" string`
      );
    }
    if (typeof fa.dir !== "string" || fa.dir.length === 0) {
      throw new Error(
        `chaosbringer: "failureArtifacts.dir" must be a non-empty string`
      );
    }
    if (
      fa.maxArtifacts !== undefined &&
      (!Number.isInteger(fa.maxArtifacts) || fa.maxArtifacts < 0)
    ) {
      throw new Error(
        `chaosbringer: "failureArtifacts.maxArtifacts" must be a non-negative integer`
      );
    }
  }

  if (options.perf !== undefined) validatePerf(options.perf);
  if (options.perfBudgets !== undefined) {
    validatePerfBudgets(options.perfBudgets);
    if (options.perf === false && options.perfBudgets.length > 0) {
      // Every rule would pass without a span to check, which reads as "within
      // budget" rather than "not measured".
      throw new Error(
        `chaosbringer: "perfBudgets" needs per-step measurement, but "perf" is false (drop "perf: false", or the rules)`
      );
    }
  }

  if (options.performanceBudget !== undefined) {
    const budget = options.performanceBudget;
    if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
      throw new Error(
        `chaosbringer: "performanceBudget" must be an object (got ${JSON.stringify(budget)})`
      );
    }
    const allowed = new Set<string>(PERF_BUDGET_KEYS);
    for (const key of Object.keys(budget)) {
      if (!allowed.has(key)) {
        throw new Error(
          `chaosbringer: "performanceBudget.${key}" is not a known metric (allowed: ${PERF_BUDGET_KEYS.join(", ")})`
        );
      }
      const val = (budget as Record<string, unknown>)[key];
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
        throw new Error(
          `chaosbringer: "performanceBudget.${key}" must be a positive number of ms (got ${JSON.stringify(val)})`
        );
      }
    }
  }
}

const PERF_BUDGET_RULE_KEYS = new Set(["match", "budget", "exact"]);

/**
 * `perfBudgets` is an array of `{ match, budget }`. The metric names are
 * lightbringer's `BUDGET_METRIC` keys — read from there, not copied, so a
 * metric lightbringer adds is accepted here the day it lands. Unknown keys
 * are refused outright: a misspelt `blockingMS` would otherwise be a budget
 * that never fires. A limit of 0 is allowed (`perf emit-budgets` writes 0
 * for a metric whose median was 0, e.g. no requests on a click).
 */
export function validatePerfBudgets(rules: unknown): void {
  if (!Array.isArray(rules)) {
    throw new Error(
      `chaosbringer: "perfBudgets" must be an array of { match, budget } (got ${JSON.stringify(rules)})`
    );
  }
  const metrics = Object.keys(BUDGET_METRIC);
  rules.forEach((rule: unknown, i) => {
    const at = `perfBudgets[${i}]`;
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`chaosbringer: "${at}" must be an object like { match, budget }`);
    }
    const r = rule as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!PERF_BUDGET_RULE_KEYS.has(key)) {
        throw new Error(`chaosbringer: "${at}.${key}" is not a rule field (allowed: match, budget, exact)`);
      }
    }
    if (r.exact !== undefined && typeof r.exact !== "boolean") {
      throw new Error(`chaosbringer: "${at}.exact" must be a boolean (got ${JSON.stringify(r.exact)})`);
    }
    if (typeof r.match !== "string" || r.match.length === 0) {
      throw new Error(`chaosbringer: "${at}.match" must be a non-empty glob over perfKey (got ${JSON.stringify(r.match)})`);
    }
    const budget = r.budget;
    if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
      throw new Error(`chaosbringer: "${at}.budget" must be an object of metric → limit`);
    }
    for (const [metric, limit] of Object.entries(budget as Record<string, unknown>)) {
      if (!metrics.includes(metric)) {
        throw new Error(
          `chaosbringer: "${at}.budget.${metric}" is not a budget metric (allowed: ${metrics.join(", ")})`
        );
      }
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
        throw new Error(
          `chaosbringer: "${at}.budget.${metric}" must be a non-negative number (got ${JSON.stringify(limit)})`
        );
      }
    }
  });
}
