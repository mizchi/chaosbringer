/**
 * Stateful journey parity.
 *
 * Where `parity` probes one-shot independent paths, `journey` replays
 * a recorded sequence (POST /todos → GET /todos, login → fetch profile,
 * checkout → list orders) against both runtimes and surfaces step-level
 * divergence. Catches the bug class that's invisible to single-path
 * probes: a write that's silently dropped, a token that flips to 401
 * later, a sort order that drifts after N writes.
 *
 * Cookies are tracked per-side automatically: a response's Set-Cookie
 * is parsed and replayed on subsequent requests on the same side. Each
 * side has an isolated jar so the comparison stays apples-to-apples.
 *
 * Step-level comparison reuses parity's `classify()` and `SideResult`
 * — same precedence rules (status → header → body → exception), same
 * opt-in checks (`checkBody`, `checkHeaders`). Exception checking is
 * intentionally NOT exposed here in v1: replaying a journey in a
 * browser per side per step is browser-launch overhead times step
 * count, and the failure mode that motivated this (silent write drop)
 * surfaces in body/status without it.
 */

import { createHash } from "node:crypto";
import { diffJsonBodies, type BodyDiffResult } from "./body-diff.js";
import type {
  MismatchKind,
  ParityReport,
  RunParityOptions,
  SideResult,
} from "./parity.js";

export interface CaptureSpec {
  /**
   * Source to extract from. Two prefixes are supported:
   * - `body.<dot.path>` — parse the response as JSON and walk the path
   *   (e.g. `body.id`, `body.user.id`, `body.items.0.id`).
   * - `header.<name>` — case-insensitive response header (e.g.
   *   `header.x-request-id`).
   *
   * Extraction failures (non-JSON body, missing path) leave the var
   * unset on that side, so a subsequent `{{var}}` template renders as
   * the literal `{{var}}` — visible noise in the URL that the parity
   * comparison then flags as a status mismatch. The journey doesn't
   * silently swallow extraction failures.
   */
  from: string;
  /** Variable name to bind. Substituted as `{{as}}` in later steps. */
  as: string;
}

export interface JourneyStep {
  /** HTTP method. Case-insensitive; uppercased internally. */
  method: string;
  /**
   * Pathname (joined with the base URL). May contain `{{var}}`
   * placeholders that reference variables captured by earlier steps.
   */
  path: string;
  /**
   * Request body. Strings sent verbatim; objects JSON-stringified with
   * `application/json` content-type unless `headers` overrides. Both
   * forms may contain `{{var}}` placeholders.
   */
  body?: string | Record<string, unknown>;
  /**
   * Extra request headers (case-insensitive merged with content-type).
   * Header values may contain `{{var}}` (useful for Authorization
   * tokens captured from a login step).
   */
  headers?: Record<string, string>;
  /**
   * Variables to capture from this step's response. Each is bound on
   * the side it ran on, so a token captured from left's login is only
   * visible to subsequent left steps. Asymmetric values across sides
   * (e.g. server-generated IDs that differ) are exactly the point —
   * the comparison runs on the substituted result.
   */
  capture?: CaptureSpec[];
  /**
   * Actor identity for multi-tenant journeys. Each actor on each side
   * has its own cookie jar and variable bag. Catches the bug class
   * where v2 leaks one user's session state into another's
   * subsequent request.
   *
   * Steps without an `actor` use the implicit `"_default"` actor, so
   * single-actor journeys are unchanged. Switching actors mid-flow is
   * the point — see the playground's tenant-isolation demo for the
   * canonical shape (Alice creates → Bob lists → Bob must not see
   * Alice's data).
   */
  actor?: string;
  /** Optional label for reporting — defaults to `<METHOD> <path>`. */
  label?: string;
}

export interface JourneyStepResult {
  /** 0-based step index in the input list. */
  index: number;
  label: string;
  request: { method: string; path: string };
  left: SideResult;
  right: SideResult;
}

export interface JourneyMismatch extends JourneyStepResult {
  /** See parity.ParityMismatch.kinds — all detected kinds in precedence order. */
  kinds: MismatchKind[];
  /** Localised JSON body diff, populated only when `kinds` contains `"body"`. */
  bodyDiff?: BodyDiffResult;
}

export interface JourneyReport {
  left: string;
  right: string;
  stepsChecked: number;
  mismatches: JourneyMismatch[];
  matches: JourneyStepResult[];
}

export interface RunJourneyOptions {
  left: string;
  right: string;
  steps: JourneyStep[];
  /** Per-request timeout. Defaults to 10s. */
  timeoutMs?: number;
  /**
   * Read + hash response bodies. Same semantics as `parity.checkBody`.
   * On for journeys by default because the most common journey bug
   * (silent write drop) surfaces in the read step's body.
   */
  checkBody?: boolean;
  /** Compare named response headers per step. Same semantics as parity. */
  checkHeaders?: string[];
  /**
   * Stop the journey on the first mismatch instead of running every
   * step. Useful when later steps depend on earlier ones succeeding
   * (a failed login means the rest of the flow is meaningless).
   */
  stopOnMismatch?: boolean;
  /** Override fetch for testing. */
  fetcher?: typeof fetch;
}

// ─── Minimal cookie jar ───────────────────────────────────────────────────
// Just enough Set-Cookie parsing to support same-host sequences. We
// deliberately skip expiry / path / domain matching because the journey
// only ever talks to one base URL — getting tough-cookie right is more
// work than the bug it would catch.

interface CookieJar {
  cookies: Map<string, string>;
  apply(setCookie: string[] | null): void;
  asHeader(): string | undefined;
}

function makeJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    cookies,
    apply(setCookie) {
      if (!setCookie) return;
      for (const raw of setCookie) {
        // Set-Cookie: name=value; Expires=...; Path=/; HttpOnly
        const semi = raw.indexOf(";");
        const pair = semi >= 0 ? raw.slice(0, semi) : raw;
        const eq = pair.indexOf("=");
        if (eq < 1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        cookies.set(name, value);
      }
    },
    asHeader() {
      if (cookies.size === 0) return undefined;
      const parts: string[] = [];
      for (const [k, v] of cookies) parts.push(`${k}=${v}`);
      return parts.join("; ");
    },
  };
}

function joinBase(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Substitute `{{name}}` placeholders against a variable bag. Missing
 * vars are intentionally left as literal `{{name}}` text so the parity
 * comparison sees the failure (the request goes out with garbled
 * URLs / bodies) rather than silently inserting `undefined`.
 */
function subst(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const k = (key as string).trim();
    return Object.hasOwn(vars, k) ? vars[k] : match;
  });
}

/**
 * Apply `subst` recursively through a JSON-shaped body. Leaves
 * non-string leaves (numbers, booleans, nulls) untouched.
 */
function substBody(body: unknown, vars: Record<string, string>): unknown {
  if (typeof body === "string") return subst(body, vars);
  if (Array.isArray(body)) return body.map((v) => substBody(v, vars));
  if (body !== null && typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) out[k] = substBody(v, vars);
    return out;
  }
  return body;
}

/**
 * Walk a dotted path into a JSON value. Numeric segments index into
 * arrays (`body.items.0.id`). Returns `undefined` when any segment
 * misses — the capture is then skipped, leaving the var unset.
 */
function dotGet(value: unknown, path: string): unknown {
  if (path.length === 0) return value;
  let curr: unknown = value;
  for (const seg of path.split(".")) {
    if (curr === null || curr === undefined) return undefined;
    if (Array.isArray(curr)) {
      const idx = Number.parseInt(seg, 10);
      if (!Number.isFinite(idx)) return undefined;
      curr = curr[idx];
    } else if (typeof curr === "object") {
      curr = (curr as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return curr;
}

/**
 * Apply capture specs against a response's body (parsed JSON) and
 * headers, mutating `vars` on the side that just ran. Failures
 * (non-JSON body, missing path) skip silently so a downstream
 * substitution leaves `{{var}}` literal — the journey doesn't
 * pretend a missing capture is an empty string.
 */
function applyCaptures(
  captures: CaptureSpec[] | undefined,
  bodyText: string | null,
  headers: Headers,
  vars: Record<string, string>,
): void {
  if (!captures || captures.length === 0) return;
  let parsed: unknown = null;
  let parsedReady = false;
  for (const cap of captures) {
    let value: unknown;
    if (cap.from.startsWith("body.") || cap.from === "body") {
      if (!parsedReady) {
        try {
          parsed = bodyText !== null && bodyText.length > 0 ? JSON.parse(bodyText) : null;
        } catch {
          parsed = null;
        }
        parsedReady = true;
      }
      const sub = cap.from === "body" ? "" : cap.from.slice("body.".length);
      value = dotGet(parsed, sub);
    } else if (cap.from.startsWith("header.")) {
      value = headers.get(cap.from.slice("header.".length));
    }
    if (value !== undefined && value !== null) {
      vars[cap.as] = String(value);
    }
  }
}

/**
 * Read the raw Set-Cookie values from a Response. `Headers.get("set-cookie")`
 * collapses repeats with `, ` which loses the per-cookie boundary. Where
 * available, `Headers.getSetCookie()` (Node 19+, undici 5.x+) preserves them.
 * Fall back to the joined string when the runtime doesn't have it.
 */
function readSetCookie(headers: Headers): string[] | null {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    const arr = anyHeaders.getSetCookie();
    return arr.length > 0 ? arr : null;
  }
  const joined = headers.get("set-cookie");
  return joined ? [joined] : null;
}

interface ProbedStep {
  result: SideResult;
  bodyText: string | null;
}

async function runStepOnSide(
  base: string,
  step: JourneyStep,
  jar: CookieJar,
  vars: Record<string, string>,
  opts: Required<Pick<RunJourneyOptions, "timeoutMs" | "checkBody">> & {
    checkHeaders: string[];
    fetcher: typeof fetch;
  },
): Promise<ProbedStep> {
  // All three of path / headers / body can carry `{{var}}` references
  // captured by earlier steps. Substitution happens BEFORE the request
  // goes out so the server sees the resolved value; the SideResult
  // captures the actual response (whose body still feeds the NEXT
  // step's captures).
  const resolvedPath = subst(step.path, vars);
  const url = joinBase(base, resolvedPath);
  const method = step.method.toUpperCase();

  const headers = new Headers();
  for (const [k, v] of Object.entries(step.headers ?? {})) {
    headers.set(k, subst(v, vars));
  }
  let body: BodyInit | undefined;
  if (step.body !== undefined) {
    if (typeof step.body === "string") {
      body = subst(step.body, vars);
    } else {
      body = JSON.stringify(substBody(step.body, vars));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  const cookieHeader = jar.asHeader();
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const resp = await opts.fetcher(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    // Cookies set by the response are visible to the next step on
    // THIS side — the per-side jar is what binds a write to its
    // subsequent read.
    jar.apply(readSetCookie(resp.headers));
    const result: SideResult = {
      status: resp.status,
      location: resp.headers.get("location"),
    };
    if (opts.checkHeaders.length > 0) {
      const out: Record<string, string | null> = {};
      for (const name of opts.checkHeaders) out[name] = resp.headers.get(name);
      result.headers = out;
    }
    // We read the body when ANY of capture / checkBody asked for it.
    // Reading once + reusing both lets us avoid two body reads.
    const needsBody = opts.checkBody || (step.capture && step.capture.length > 0);
    let bodyText: string | null = null;
    if (needsBody) {
      const bytes = new Uint8Array(await resp.arrayBuffer());
      bodyText = new TextDecoder().decode(bytes);
      if (opts.checkBody) {
        result.bodyLength = bytes.byteLength;
        result.bodyHash = createHash("sha256").update(bytes).digest("hex");
      }
    }
    applyCaptures(step.capture, bodyText, resp.headers, vars);
    return { result, bodyText };
  } catch (err) {
    return {
      result: {
        status: null,
        error: err instanceof Error ? err.message : String(err),
      },
      bodyText: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same shape as parity's classify — all detected kinds in precedence
 * order, empty array means match. Inlined rather than imported so the
 * journey omits exception detection (see file header).
 */
function classifyStep(left: SideResult, right: SideResult): MismatchKind[] {
  const leftFailed = left.status === null;
  const rightFailed = right.status === null;
  if (leftFailed !== rightFailed) return ["failure"];
  if (leftFailed && rightFailed) return [];
  if (left.status !== right.status) return ["status"];
  if (
    typeof left.status === "number" &&
    left.status >= 300 &&
    left.status < 400 &&
    left.location !== right.location
  ) {
    return ["redirect"];
  }
  const kinds: MismatchKind[] = [];
  if (left.headers && right.headers) {
    for (const name of Object.keys(left.headers)) {
      if (left.headers[name] !== right.headers[name]) {
        kinds.push("header");
        break;
      }
    }
  }
  if (
    left.bodyHash !== undefined &&
    right.bodyHash !== undefined &&
    left.bodyHash !== right.bodyHash
  ) {
    kinds.push("body");
  }
  return kinds;
}

export async function runJourney(opts: RunJourneyOptions): Promise<JourneyReport> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const checkBody = opts.checkBody ?? true;
  const checkHeaders = (opts.checkHeaders ?? []).map((h) => h.toLowerCase());
  const fetcher = opts.fetcher ?? fetch;
  const stopOnMismatch = opts.stopOnMismatch ?? false;

  // Per-side, per-actor cookie jars + variable bags. The two levels
  // of keying matter:
  //   - Outer (left/right): the parity comparison axis.
  //   - Inner (actor): the tenant isolation axis. A bug where v2
  //     mixes actor A's session into actor B's request only shows
  //     up if Bob's GET goes out with Bob's cookies, not Alice's.
  const leftJars = new Map<string, CookieJar>();
  const rightJars = new Map<string, CookieJar>();
  const leftVarsByActor = new Map<string, Record<string, string>>();
  const rightVarsByActor = new Map<string, Record<string, string>>();
  function getJar(side: "left" | "right", actor: string): CookieJar {
    const map = side === "left" ? leftJars : rightJars;
    let jar = map.get(actor);
    if (!jar) {
      jar = makeJar();
      map.set(actor, jar);
    }
    return jar;
  }
  function getVars(side: "left" | "right", actor: string): Record<string, string> {
    const map = side === "left" ? leftVarsByActor : rightVarsByActor;
    let vars = map.get(actor);
    if (!vars) {
      vars = {};
      map.set(actor, vars);
    }
    return vars;
  }

  const mismatches: JourneyMismatch[] = [];
  const matches: JourneyStepResult[] = [];

  let stepsChecked = 0;
  for (let i = 0; i < opts.steps.length; i++) {
    const step = opts.steps[i];
    const sideOpts = { timeoutMs, checkBody, checkHeaders, fetcher };
    // Per-step parallel: each side advances independently. State
    // accumulates in its own jar.
    const actor = step.actor ?? "_default";
    const [leftProbe, rightProbe] = await Promise.all([
      runStepOnSide(opts.left, step, getJar("left", actor), getVars("left", actor), sideOpts),
      runStepOnSide(opts.right, step, getJar("right", actor), getVars("right", actor), sideOpts),
    ]);
    const left = leftProbe.result;
    const right = rightProbe.result;
    const label = step.label ?? `${step.method.toUpperCase()} ${step.path}`;
    const result: JourneyStepResult = {
      index: i,
      label,
      request: { method: step.method.toUpperCase(), path: step.path },
      left,
      right,
    };
    stepsChecked++;
    const kinds = classifyStep(left, right);
    if (kinds.length > 0) {
      const mismatch: JourneyMismatch = { ...result, kinds };
      if (kinds.includes("body")) {
        const diff = diffJsonBodies(leftProbe.bodyText, rightProbe.bodyText);
        if (diff) mismatch.bodyDiff = diff;
      }
      mismatches.push(mismatch);
      if (stopOnMismatch) break;
    } else {
      matches.push(result);
    }
  }

  return {
    left: opts.left,
    right: opts.right,
    stepsChecked,
    mismatches,
    matches,
  };
}

// Re-export parity types for callers that don't want a separate import.
export type { MismatchKind, ParityReport, RunParityOptions, SideResult };
