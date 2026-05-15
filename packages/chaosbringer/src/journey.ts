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
import type {
  MismatchKind,
  ParityReport,
  RunParityOptions,
  SideResult,
} from "./parity.js";

export interface JourneyStep {
  /** HTTP method. Case-insensitive; uppercased internally. */
  method: string;
  /** Pathname (joined with the base URL). */
  path: string;
  /**
   * Request body. Strings sent verbatim; objects JSON-stringified with
   * `application/json` content-type unless `headers` overrides.
   */
  body?: string | Record<string, unknown>;
  /** Extra request headers (case-insensitive merged with content-type). */
  headers?: Record<string, string>;
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
  kind: MismatchKind;
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

async function runStepOnSide(
  base: string,
  step: JourneyStep,
  jar: CookieJar,
  opts: Required<Pick<RunJourneyOptions, "timeoutMs" | "checkBody">> & {
    checkHeaders: string[];
    fetcher: typeof fetch;
  },
): Promise<SideResult> {
  const url = joinBase(base, step.path);
  const method = step.method.toUpperCase();

  const headers = new Headers();
  for (const [k, v] of Object.entries(step.headers ?? {})) headers.set(k, v);
  let body: BodyInit | undefined;
  if (step.body !== undefined) {
    if (typeof step.body === "string") {
      body = step.body;
    } else {
      body = JSON.stringify(step.body);
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
    if (opts.checkBody) {
      const bytes = new Uint8Array(await resp.arrayBuffer());
      result.bodyLength = bytes.byteLength;
      result.bodyHash = createHash("sha256").update(bytes).digest("hex");
    }
    return result;
  } catch (err) {
    return {
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Local copy of parity's classify with the same precedence chain.
 * Inlined (rather than imported) so journey can omit the exception
 * branch — see file header for why exception checking is not exposed
 * here in v1.
 */
function classifyStep(left: SideResult, right: SideResult): MismatchKind | null {
  const leftFailed = left.status === null;
  const rightFailed = right.status === null;
  if (leftFailed !== rightFailed) return "failure";
  if (leftFailed && rightFailed) return null;
  if (left.status !== right.status) return "status";
  if (
    typeof left.status === "number" &&
    left.status >= 300 &&
    left.status < 400 &&
    left.location !== right.location
  ) {
    return "redirect";
  }
  if (left.headers && right.headers) {
    for (const name of Object.keys(left.headers)) {
      if (left.headers[name] !== right.headers[name]) return "header";
    }
  }
  if (
    left.bodyHash !== undefined &&
    right.bodyHash !== undefined &&
    left.bodyHash !== right.bodyHash
  ) {
    return "body";
  }
  return null;
}

export async function runJourney(opts: RunJourneyOptions): Promise<JourneyReport> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const checkBody = opts.checkBody ?? true;
  const checkHeaders = (opts.checkHeaders ?? []).map((h) => h.toLowerCase());
  const fetcher = opts.fetcher ?? fetch;
  const stopOnMismatch = opts.stopOnMismatch ?? false;

  const leftJar = makeJar();
  const rightJar = makeJar();

  const mismatches: JourneyMismatch[] = [];
  const matches: JourneyStepResult[] = [];

  let stepsChecked = 0;
  for (let i = 0; i < opts.steps.length; i++) {
    const step = opts.steps[i];
    const sideOpts = { timeoutMs, checkBody, checkHeaders, fetcher };
    // Per-step parallel: each side advances independently. State
    // accumulates in its own jar.
    const [left, right] = await Promise.all([
      runStepOnSide(opts.left, step, leftJar, sideOpts),
      runStepOnSide(opts.right, step, rightJar, sideOpts),
    ]);
    const label = step.label ?? `${step.method.toUpperCase()} ${step.path}`;
    const result: JourneyStepResult = {
      index: i,
      label,
      request: { method: step.method.toUpperCase(), path: step.path },
      left,
      right,
    };
    stepsChecked++;
    const kind = classifyStep(left, right);
    if (kind) {
      mismatches.push({ ...result, kind });
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
