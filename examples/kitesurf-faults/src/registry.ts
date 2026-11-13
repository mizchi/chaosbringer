/**
 * The host Worker's run registry: which test-owned run a CDP connection
 * belongs to, and the fault session that run owns.
 *
 * Lives in host memory, one isolate, for the life of the `wrangler dev`
 * process: Service Binding props must be serializable, so the session object
 * cannot travel with the binding, only its run id can. Nothing here survives
 * a Worker restart, and nothing tries to; a lookup that fails is `run-lost`,
 * which the host reports as an error rather than starting a fresh session or
 * passing traffic through unfaulted.
 *
 * Bounded both ways the issue asks for: at most `maxRuns` live entries, and
 * an entry older than `maxAgeMs` is disposed and dropped the next time a run
 * is created, so a harness that crashed before its `finally` cannot pin
 * sessions forever.
 *
 * Pure (no Workers APIs) so it runs as a unit test.
 */

export const MAX_RUNS = 8;
export const MAX_RUN_AGE_MS = 600_000;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the telemetry sink saw when the engine ended a connection of this run. */
export interface SessionEnd {
  connectionId: string;
  at: number;
  endReason?: unknown;
  closeCode?: unknown;
}

export interface RunEntry<S> {
  readonly id: string;
  readonly createdAt: number;
  session: S;
  disposed: boolean;
  /** Calls that reached the fixture server, by pathname, counted before any await. */
  upstream: Record<string, number>;
  /** ChaosEgress calls not yet settled. Must be 0 once a run is torn down. */
  inFlight: number;
  /** Calls a dispose cut short while they were in flight. */
  disposedInFlight: number;
  /** Calls rejected because their caller cancelled them (Request.signal). */
  callerCancelled: number;
  sessionEnds: SessionEnd[];
}

export type CreateResult<S> =
  | { ok: true; entry: RunEntry<S> }
  | { ok: false; status: 400 | 409 | 429; error: string };

export interface RegistryOptions {
  maxRuns?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export class RunRegistry<S extends { dispose(): Promise<void> }> {
  readonly #runs = new Map<string, RunEntry<S>>();
  readonly #maxRuns: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(options: RegistryOptions = {}) {
    this.#maxRuns = options.maxRuns ?? MAX_RUNS;
    this.#maxAgeMs = options.maxAgeMs ?? MAX_RUN_AGE_MS;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#runs.size;
  }

  /**
   * Register run `id`. `makeSession` gets the entry first so the upstream it
   * wraps can count into `entry.upstream`; if it throws (a rule the session
   * refuses), nothing is registered.
   */
  create(id: string, makeSession: (entry: Omit<RunEntry<S>, "session">) => S): CreateResult<S> {
    if (!RUN_ID.test(id)) return { ok: false, status: 400, error: "run id must match [A-Za-z0-9_-]{1,64}" };
    this.sweep();
    if (this.#runs.has(id)) return { ok: false, status: 409, error: `run ${id} already exists` };
    if (this.#runs.size >= this.#maxRuns) return { ok: false, status: 429, error: `at most ${this.#maxRuns} runs at once` };
    const partial: Omit<RunEntry<S>, "session"> = {
      id,
      createdAt: this.#now(),
      disposed: false,
      upstream: {},
      inFlight: 0,
      disposedInFlight: 0,
      callerCancelled: 0,
      sessionEnds: [],
    };
    let session: S;
    try {
      session = makeSession(partial);
    } catch (error) {
      return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
    }
    // The same object the factory saw, so its counters stay the entry's own.
    const entry = Object.assign(partial, { session }) as RunEntry<S>;
    this.#runs.set(id, entry);
    return { ok: true, entry };
  }

  get(id: string): RunEntry<S> | undefined {
    return this.#runs.get(id);
  }

  /** Dispose the run's session once; the entry stays readable for its stats. */
  async dispose(id: string): Promise<RunEntry<S> | undefined> {
    const entry = this.#runs.get(id);
    if (!entry) return undefined;
    if (!entry.disposed) {
      entry.disposed = true;
      entry.disposedInFlight += entry.inFlight;
      await entry.session.dispose();
    }
    return entry;
  }

  /** Dispose and forget. A connection still bound to the id is now run-lost. */
  async delete(id: string): Promise<RunEntry<S> | undefined> {
    const entry = await this.dispose(id);
    this.#runs.delete(id);
    return entry;
  }

  /** Drop runs past the age limit. Returns their ids. */
  sweep(): string[] {
    const cutoff = this.#now() - this.#maxAgeMs;
    const swept: string[] = [];
    for (const [id, entry] of this.#runs) {
      if (entry.createdAt >= cutoff) continue;
      swept.push(id);
      this.#runs.delete(id);
      if (!entry.disposed) {
        entry.disposed = true;
        void entry.session.dispose();
      }
    }
    return swept;
  }
}
