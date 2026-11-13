/**
 * Option checking and copying for `createFaultEgress`.
 *
 * Everything a transport cannot honour is refused here, at construction,
 * rather than ignored per request: a rule that silently does nothing presents
 * as "my fault never fired", and on Kitesurf finding that out costs a whole
 * workerd + engine run.
 */

import { toRegExp, validateFaultSchedule } from "@mizchi/playwright-faults/network";
import { KitesurfFaultsError } from "./errors.js";
import type { Fault, FaultEgressOptions, FaultRule, FaultSchedule } from "./types.js";

/** `maxDelayMs` when the caller names none. */
export const DEFAULT_MAX_DELAY_MS = 5000;
/**
 * Largest `maxDelayMs` accepted. The engine allows 10 s for response headers
 * (25 s for a top-level document) and that budget is not extended for fault
 * injection, so a longer delay would test the engine's timeout, not the page.
 */
export const MAX_DELAY_CAP_MS = 5000;

const UINT32_MAX = 0xffffffff;

export interface CheckedOptions {
  rules: FaultRule[];
  seed: number;
  maxDelayMs: number;
}

function fail(message: string): never {
  throw new KitesurfFaultsError("invalid-config", `kitesurf-faults: ${message}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Validate `options` and return a private, frozen copy of the rules. */
export function checkOptions(options: FaultEgressOptions): CheckedOptions {
  if (!isObject(options)) fail("options must be an object with `rules` and `seed`");
  const { rules, seed, maxDelayMs = DEFAULT_MAX_DELAY_MS } = options;

  if (!Number.isInteger(seed) || seed < 0 || seed > UINT32_MAX) {
    fail(`seed must be an integer in 0..${UINT32_MAX} (got ${String(seed)})`);
  }
  if (typeof maxDelayMs !== "number" || !Number.isFinite(maxDelayMs) || maxDelayMs < 0 || maxDelayMs > MAX_DELAY_CAP_MS) {
    fail(`maxDelayMs must be a finite number in 0..${MAX_DELAY_CAP_MS} (got ${String(maxDelayMs)})`);
  }
  if (!Array.isArray(rules)) fail("rules must be an array (it may be empty)");

  return { rules: rules.map((rule, i) => checkRule(rule, i, maxDelayMs)), seed, maxDelayMs };
}

function checkRule(rule: FaultRule, i: number, maxDelayMs: number): FaultRule {
  if (!isObject(rule)) fail(`rule #${i} must be an object`);
  const label = typeof rule.name === "string" ? `rule "${rule.name}"` : `rule #${i}`;
  if (rule.name !== undefined && typeof rule.name !== "string") fail(`${label} has a non-string name`);

  const { urlPattern } = rule;
  if (!(typeof urlPattern === "string" || urlPattern instanceof RegExp) || toRegExp(urlPattern) === null) {
    fail(`${label} has an invalid urlPattern (${JSON.stringify(String(urlPattern))}): expected a RegExp or a valid regular expression string`);
  }

  if (rule.methods !== undefined) {
    if (!Array.isArray(rule.methods) || rule.methods.length === 0 || !rule.methods.every((m) => typeof m === "string" && m !== "")) {
      // An empty list matches no method at all in the shared matcher, which is
      // a rule that never fires; omit `methods` to match every method.
      fail(`${label} has invalid methods: expected a non-empty array of method names, or no methods field to match every method`);
    }
  }

  if ("resourceTypes" in rule) {
    // Kitesurf strips its `x-kitesurf-*` headers before egress, so the
    // transport cannot know what kind of request it is handed. Guessing from
    // the extension or `Accept` would fault a different set of requests than
    // the same rule on Chromium; even `[]` is refused so the field never
    // looks honoured.
    fail(`${label}: resourceTypes is not supported on Kitesurf egress (x-kitesurf-* headers are stripped before egress, so the resource type is unknown)`);
  }

  if (rule.probability !== undefined) {
    const p = rule.probability;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      fail(`${label} has an invalid probability (${String(p)}): expected a number in 0..1`);
    }
  }
  if (rule.schedule !== undefined && !isObject(rule.schedule)) fail(`${label} has a schedule that is not an object`);
  try {
    validateFaultSchedule(label, rule, "kitesurf-faults");
  } catch (e) {
    // Same message, but as this package's error type so a caller can branch
    // on `code` for every configuration error.
    throw new KitesurfFaultsError("invalid-config", (e as Error).message);
  }

  const fault = checkFault(rule.fault, label, maxDelayMs);
  return Object.freeze({
    ...(rule.name !== undefined ? { name: rule.name } : {}),
    // A fresh RegExp: the caller's may be shared, and with `g` or `y` its
    // `lastIndex` would be ours to move.
    urlPattern: typeof urlPattern === "string" ? urlPattern : new RegExp(urlPattern.source, urlPattern.flags),
    ...(rule.methods !== undefined ? { methods: Object.freeze([...rule.methods]) as string[] } : {}),
    fault,
    ...(rule.probability !== undefined ? { probability: rule.probability } : {}),
    ...(rule.schedule !== undefined ? { schedule: copySchedule(rule.schedule) } : {}),
  });
}

function copySchedule(schedule: FaultSchedule): FaultSchedule {
  return Object.freeze({
    decisions: Object.freeze([...schedule.decisions]),
    ...(schedule.afterEnd !== undefined ? { afterEnd: schedule.afterEnd } : {}),
  });
}

function checkFault(fault: Fault, label: string, maxDelayMs: number): Fault {
  if (!isObject(fault)) fail(`${label} has no fault: expected { kind: "status" | "abort" | "delay", … }`);
  switch (fault.kind) {
    case "status": {
      const { status, body, contentType } = fault;
      // Below 400 is not a fault, and a 1xx/3xx built here would be a
      // Response the engine has to treat as a real interim or redirect.
      if (!Number.isInteger(status) || status < 400 || status > 599) {
        fail(`${label} has an invalid status (${String(status)}): expected an integer in 400..599`);
      }
      if (body !== undefined && typeof body !== "string") fail(`${label} has a status body that is not a string`);
      if (contentType !== undefined && typeof contentType !== "string") fail(`${label} has a contentType that is not a string`);
      return Object.freeze({
        kind: "status",
        status,
        ...(body !== undefined ? { body } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
      });
    }
    case "abort": {
      // A Workers transport can make a fetch fail; it cannot make it fail as
      // Chromium's `timedout` or `connectionrefused`, so only the generic code
      // is accepted rather than one that is reported and not reproduced.
      if (fault.errorCode !== undefined && fault.errorCode !== "failed") {
        fail(`${label} has abort errorCode ${JSON.stringify(fault.errorCode)}: only "failed" (or none) can be reproduced on Kitesurf egress`);
      }
      return Object.freeze({ kind: "abort" });
    }
    case "delay": {
      const { ms } = fault;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
        fail(`${label} has an invalid delay ms (${String(ms)}): expected a finite number >= 0`);
      }
      if (ms > maxDelayMs) {
        // Refused, not clamped: a clamped delay is a different experiment
        // reported under the rule's name.
        fail(`${label} asks for a ${ms} ms delay, over maxDelayMs (${maxDelayMs})`);
      }
      return Object.freeze({ kind: "delay", ms });
    }
    case "hang":
      fail(`${label}: the hang fault is not supported on Kitesurf egress yet (the engine's own request deadline would end it); use a bounded delay`);
    default:
      fail(`${label} has an unsupported fault kind ${JSON.stringify((fault as { kind?: unknown }).kind)}: expected "status", "abort" or "delay"`);
  }
}
