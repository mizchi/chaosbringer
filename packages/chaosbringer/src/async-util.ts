/**
 * Dependency-free async helpers. A leaf module, so the settle state machine
 * (used with perf off) and the perf glue can share them without settle
 * depending on the lightbringer session layer.
 */

/** What {@link raceTimeout} resolves to when `ms` passed first. */
export const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * `p`, or {@link TIMED_OUT} if `ms` passes first. The timer is cleared either
 * way, so a settled race never keeps the process alive. A rejection of `p`
 * propagates.
 */
export async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
