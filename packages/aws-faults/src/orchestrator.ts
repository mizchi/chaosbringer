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

/**
 * A timed phase of a drill. The orchestrator installs `rules`, samples for
 * `durationMs`, then moves to the next phase. After the last phase, rules
 * stay installed during the recovery window — the AI must hold SLO at the
 * lingering condition, not wait it out.
 *
 * To model a clean post-incident "back to normal" tail, end your phase list
 * with a phase whose `rules: []` clears everything.
 */
export interface Phase {
  /** Human label, used in onSample callbacks and the report. */
  label: string;
  /** How long this phase runs. */
  durationMs: number;
  /** Rules installed at the start of this phase (replaces previous phase's). */
  rules: Rule[];
}

export interface Drill {
  id: string;
  name: string;
  description: string;
  /**
   * Simple-mode rules. Installed once, kept for the whole inject window.
   * Mutually exclusive with `phases` — if both are set, `phases` wins.
   */
  rules?: Rule[];
  /**
   * Time-shaped phases. Reproduces the curve of a real incident: onset →
   * peak → partial recovery → tail. See `drills/incidents/` for examples.
   */
  phases?: Phase[];
  /**
   * Index of the "peak" phase within `phases`. Used by tools like the
   * eval-prepare CLI to install the right rules for a static-impact
   * eval. Defaults to 0; drills where the worst phase isn't first
   * should set this explicitly (e.g. DDB peak is at index 1, after
   * the onset ramp-up).
   */
  peakPhaseIndex?: number;
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
  /**
   * For simple-mode drills, how long the (single) inject phase lasts.
   * Ignored for phased drills.
   */
  simpleInjectMs?: number;
  /** Stream observations live; default logs to stderr. */
  onSample?: (phase: string, sample: HealthCheckResult) => void;
}

export interface PhaseSamples {
  label: string;
  samples: HealthCheckResult[];
}

export interface DrillReport {
  drillId: string;
  passed: boolean;
  baseline: HealthCheckResult[];
  /** Samples grouped by the phase active at the time. */
  injectedByPhase: PhaseSamples[];
  /** Flat list of inject samples; preserved for compatibility with prior shape. */
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
 *   1. Baseline (no chaos) for `baselineMs`
 *   2. For each phase: install phase.rules, sample for phase.durationMs
 *   3. Recovery: keep the LAST phase's rules active, poll until acceptance
 *      met for `consecutiveGreen` samples or `recoveryTimeoutMs` elapses
 *   4. Clear all rules on exit
 *
 * "Phases" are how incident replays model the real shape of an outage
 * (onset → peak → partial recovery → tail). For ad-hoc drills, pass
 * `drill.rules` instead of `drill.phases` and the orchestrator wraps them
 * in a single phase whose duration is `simpleInjectMs` (default 5s).
 */
export async function runDrill(opts: RunDrillOptions): Promise<DrillReport> {
  const baselineMs = opts.baselineMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 500;
  const simpleInjectMs = opts.simpleInjectMs ?? 5_000;
  const recoveryTimeoutMs = opts.recoveryTimeoutMs ?? 120_000;
  const onSample = opts.onSample ?? defaultSampleLogger;

  const phases = normalizePhases(opts.drill, simpleInjectMs);

  const start = Date.now();
  const baseline: HealthCheckResult[] = [];
  const injectedByPhase: PhaseSamples[] = [];
  const recovery: HealthCheckResult[] = [];

  // Phase 1: baseline.
  await runWindow("baseline", baselineMs, intervalMs, opts.drill, onSample, baseline);

  // Phase 2..N: inject phases sequentially.
  for (const phase of phases) {
    await opts.chaos.installProfile(phase.rules);
    const phaseSamples: HealthCheckResult[] = [];
    await runWindow(phase.label, phase.durationMs, intervalMs, opts.drill, onSample, phaseSamples);
    injectedByPhase.push({ label: phase.label, samples: phaseSamples });
  }

  // Phase N+1: recovery probing under the last-phase rules. We do NOT clear
  // chaos rules here — the AI needs to recover while the underlying fault is
  // still active. "Wait it out" is not a valid recovery strategy.
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
    injectedByPhase,
    injected: injectedByPhase.flatMap((p) => p.samples),
    recovery,
    durationMs: Date.now() - start,
    recovered,
  };
}

function normalizePhases(d: Drill, simpleInjectMs: number): Phase[] {
  if (d.phases && d.phases.length > 0) return d.phases;
  if (d.rules && d.rules.length > 0) {
    return [{ label: "injected", durationMs: simpleInjectMs, rules: d.rules }];
  }
  return [];
}

async function runWindow(
  label: string,
  totalMs: number,
  intervalMs: number,
  d: Drill,
  onSample: (p: string, s: HealthCheckResult) => void,
  sink: HealthCheckResult[],
): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const s = await safeProbe(d);
    sink.push(s);
    onSample(label, s);
    await sleep(intervalMs);
  }
}

function meetsAcceptance(s: HealthCheckResult, a: AcceptanceCriteria): boolean {
  if (!s.ok) return false;
  if (a.p99Ms !== undefined && s.latencyMs > a.p99Ms) return false;
  if (a.errorRate !== undefined && s.errorRate > a.errorRate) return false;
  return true;
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
