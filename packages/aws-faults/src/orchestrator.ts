import type { KumoChaos } from "./client.ts";
import type { Rule } from "./types.ts";

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  errorRate: number;
  /** Free-form payload the drill can attach (counters, sample errors, etc.) */
  detail?: Record<string, unknown>;
}

export interface AcceptanceCriteria {
  /** p99 over the sample window. */
  p99Ms?: number;
  /** error rate (0..1) over the sample window. */
  errorRate?: number;
  /** how many consecutive green health checks required. */
  consecutiveGreen?: number;
}

export interface Drill {
  id: string;
  name: string;
  description: string;
  /** Rules to install via kumo /kumo/chaos/rules. */
  rules: Rule[];
  /** One probe = one synthetic user request. Should NOT throw on app errors. */
  healthCheck: () => Promise<HealthCheckResult>;
  /** SLO the drill must restore before declaring recovery. */
  acceptance: AcceptanceCriteria;
  /** Optional brief shown to the AI agent. Markdown. */
  brief?: string;
}

export interface RunDrillOptions {
  chaos: KumoChaos;
  drill: Drill;
  /** How long to gather baseline (no chaos) samples. */
  baselineMs?: number;
  /** Sampling interval. */
  intervalMs?: number;
  /** Max time we wait for recovery before declaring failure. */
  recoveryTimeoutMs?: number;
  /** Stream observations live; default logs to stderr. */
  onSample?: (phase: "baseline" | "injected" | "recovery", sample: HealthCheckResult) => void;
}

export interface DrillReport {
  drillId: string;
  passed: boolean;
  baseline: HealthCheckResult[];
  injected: HealthCheckResult[];
  recovery: HealthCheckResult[];
  durationMs: number;
  /** True if acceptance criteria were ever met during the recovery phase. */
  recovered: boolean;
}

/**
 * runDrill is the orchestrator entry point used both by the manual CLI and by
 * the AI rehearsal harness. The flow:
 *
 *   1. Gather baseline samples (no chaos installed)
 *   2. Install drill.rules via kumo runtime API
 *   3. Gather "injected" samples to confirm impact
 *   4. Yield to the caller (e.g. AI agent) and poll until acceptance met
 *      or recoveryTimeoutMs elapses
 *   5. Clear chaos rules and return the full sample log
 *
 * The function only injects + observes. It does NOT touch the target app —
 * recovery actions are up to the caller (a human, a script, or an AI agent).
 */
export async function runDrill(opts: RunDrillOptions): Promise<DrillReport> {
  const baselineMs = opts.baselineMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 500;
  const recoveryTimeoutMs = opts.recoveryTimeoutMs ?? 120_000;
  const onSample = opts.onSample ?? defaultSampleLogger;

  const start = Date.now();
  const baseline: HealthCheckResult[] = [];
  const injected: HealthCheckResult[] = [];
  const recovery: HealthCheckResult[] = [];

  // Phase 1: baseline.
  for (const sample of await sampleFor(opts.drill, baselineMs, intervalMs)) {
    baseline.push(sample);
    onSample("baseline", sample);
  }

  // Phase 2: install + confirm impact.
  await opts.chaos.installProfile(opts.drill.rules);
  for (const sample of await sampleFor(opts.drill, baselineMs, intervalMs)) {
    injected.push(sample);
    onSample("injected", sample);
  }

  // Phase 3: poll for recovery. We do NOT remove chaos rules here — the AI
  // needs to recover while the underlying fault is still active (e.g. by
  // adding retry budget, switching regions, bypassing the failing path).
  let recovered = false;
  let consecutiveGreen = 0;
  const need = opts.drill.acceptance.consecutiveGreen ?? 3;
  const deadline = Date.now() + recoveryTimeoutMs;
  while (Date.now() < deadline) {
    const sample = await safeProbe(opts.drill);
    recovery.push(sample);
    onSample("recovery", sample);
    if (meetsAcceptance(sample, opts.drill.acceptance)) {
      consecutiveGreen++;
      if (consecutiveGreen >= need) {
        recovered = true;
        break;
      }
    } else {
      consecutiveGreen = 0;
    }
    await sleep(intervalMs);
  }

  // Always clear, even on timeout, so a botched run doesn't leak chaos rules
  // into the next drill.
  await opts.chaos.clearRules();

  return {
    drillId: opts.drill.id,
    passed: recovered,
    baseline,
    injected,
    recovery,
    durationMs: Date.now() - start,
    recovered,
  };
}

function meetsAcceptance(s: HealthCheckResult, a: AcceptanceCriteria): boolean {
  if (!s.ok) return false;
  if (a.p99Ms !== undefined && s.latencyMs > a.p99Ms) return false;
  if (a.errorRate !== undefined && s.errorRate > a.errorRate) return false;
  return true;
}

async function sampleFor(d: Drill, totalMs: number, intervalMs: number): Promise<HealthCheckResult[]> {
  const out: HealthCheckResult[] = [];
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    out.push(await safeProbe(d));
    await sleep(intervalMs);
  }
  return out;
}

async function safeProbe(d: Drill): Promise<HealthCheckResult> {
  try {
    return await d.healthCheck();
  } catch (err) {
    return { ok: false, latencyMs: 0, errorRate: 1, detail: { error: String(err) } };
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function defaultSampleLogger(phase: string, s: HealthCheckResult): void {
  const tag = s.ok ? "ok" : "FAIL";
  process.stderr.write(`[${phase}] ${tag} latency=${s.latencyMs.toFixed(0)}ms errRate=${s.errorRate.toFixed(2)}\n`);
}
