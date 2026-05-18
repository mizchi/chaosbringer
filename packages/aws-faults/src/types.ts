// Wire types mirror kumo's internal/chaos/types.go. Keeping them in lockstep
// is intentional — the Go server is the source of truth, this file is the
// client view. If kumo changes the shape, this file changes too; we do not
// abstract here because drift detection is easier with a 1:1 mapping.

export type InjectKind = "latency" | "disconnect" | "awsError" | "throttle" | "silentSuccess";

export interface Match {
  service?: string;
  action?: string;
  method?: string;
  path?: string;
  pattern?: string;
  resource?: string;
}

export interface Latency {
  fixedMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
}

export interface DisconnectSpec {
  style?: "hangup" | "reset";
  afterMs?: number;
}

export interface AWSErrorSpec {
  code: string;
  httpStatus?: number;
  message?: string;
}

export interface FeedbackSpec {
  /** Sliding-window width in ms (default 1000). */
  windowMs?: number;
  /** Matches/window above which feedback engages (default 0). */
  threshold?: number;
  /** Each excess match adds this to effective probability. */
  probabilityStep?: number;
  /** Each excess match multiplies latency by (1 + step). */
  latencyMultStep?: number;
  /** Cap on effective probability (default 1.0). */
  maxProbability?: number;
  /** Cap on latency multiplier (default 10.0). */
  maxLatencyMult?: number;
}

export interface Inject {
  kind: InjectKind;
  probability: number;
  latency?: Latency;
  disconnect?: DisconnectSpec;
  awsError?: AWSErrorSpec;
  /**
   * Load-amplification: as match rate climbs over `feedback.windowMs`, the
   * rule's effective probability and latency grow. Reproduces the 2015
   * DynamoDB metadata-overload feedback loop where retry storms slowed the
   * backend, throwing more errors. See kumo-chaos-patch internal/chaos.
   */
  feedback?: FeedbackSpec;
}

export interface Rule {
  id: string;
  enabled: boolean;
  match: Match;
  inject: Inject;
}

export interface RuleStats {
  ruleId: string;
  matched: number;
  skipped: number;
  lastApply?: string;
}

export interface Snapshot {
  rules: Rule[];
  stats: RuleStats[];
}
