// Wire types mirror kumo's internal/chaos/types.go. Keeping them in lockstep
// is intentional — the Go server is the source of truth, this file is the
// client view. If kumo changes the shape, this file changes too; we do not
// abstract here because drift detection is easier with a 1:1 mapping.

export type InjectKind = "latency" | "disconnect" | "awsError" | "throttle";

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

export interface Inject {
  kind: InjectKind;
  probability: number;
  latency?: Latency;
  disconnect?: DisconnectSpec;
  awsError?: AWSErrorSpec;
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
