/**
 * Wire-your-own-target SDK (issue #118).
 *
 * The rehearsal harness's most valuable assets — the scenario catalog,
 * scoring rubric, journey-based customer probe — are independent of
 * the bundled toy Hono target. This module defines the contract a
 * target must satisfy so callers can wire the harness against their
 * own service.
 *
 * MVP scope: define the interface, ship the existing Hono target as a
 * reference implementation. The `--target <module>` flag on
 * eval-prepare / eval-score that imports a user-authored module is a
 * planned follow-up — for now, this gives consumers a contract to
 * code against and a working reference to study.
 *
 * Out of scope for this slice:
 *   - Multi-process / multi-service targets (#119 multi-service cascade
 *     coverage)
 *   - Cross-language targets (Go / Python / JVM users will need their
 *     own runtime adapters around this contract)
 *   - Pluggable scenario-shape parameterization (e.g. swap DDB ⇆ RDS)
 */

/**
 * The contract a target must satisfy to participate in a rehearsal.
 *
 * Lifecycle:
 *   boot() -> ready to take customer requests
 *   ... rehearsal runs ...
 *   restart() may be called by the agent during the run
 *   shutdown() at the end of the scenario
 *
 * Endpoint conventions: the harness expects POSTs to `customerUrl` to
 * exercise the customer-visible write path, and `probeUrl` to drive a
 * health-style write through the same path. `verifyUrl(id)` returns
 * the per-order verify URL used by chaosbringer journey probes
 * (variant-specific session invariants — see issue #114). Sources
 * the agent is allowed to read / edit live under `sourceRoots`.
 */
export interface RehearsalTarget {
  /** Start the service. Resolves when it's ready to take requests, or throws. */
  boot(): Promise<void>;

  /** Stop the service. Called between scenarios and at shutdown. */
  shutdown(): Promise<void>;

  /**
   * Restart in place. The 'restart cost' rubric criterion expects this
   * to be cheap — agents shouldn't pay a recovery-window penalty for
   * cycling the process.
   */
  restart(): Promise<void>;

  /** Endpoint the customer-impact probe POSTs to. Example: http://localhost:3000/orders */
  readonly customerUrl: string;

  /** Health-style endpoint that drives a write through the same path as customers. */
  readonly probeUrl: string;

  /** Per-order verify URL builder, used by the journey-based probe (#114). */
  verifyUrl?: (orderId: string) => string;

  /**
   * Source roots the agent is allowed to read/edit. The harness uses
   * these to confine the agent to user-owned code (e.g. excludes node_modules,
   * the kumo binary, etc.).
   */
  readonly sourceRoots: string[];

  /**
   * Async iterator yielding lines of the target's stdout+stderr. The
   * agent tails this. Implementations typically wire from a child-process
   * spawn.
   */
  logStream(): AsyncIterable<string>;
}

/**
 * Configuration available to a target factory when the harness boots it.
 * Implementations should pass these through to their underlying process.
 */
export interface TargetEnv {
  /** Where the target should connect for AWS calls. The harness boots kumo here. */
  awsEndpointUrl: string;
  /** Port the target should listen on. Default 3000. */
  port?: number;
  /** Extra env vars to forward into the target process. */
  extraEnv?: Record<string, string>;
}

/**
 * Factory shape. The user's wire-your-own-target module default-exports
 * one of these. Resolved by the (future) `--target` flag.
 */
export type TargetFactory = (env: TargetEnv) => RehearsalTarget;
