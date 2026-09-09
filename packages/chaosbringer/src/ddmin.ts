/**
 * Zeller's delta debugging (ddmin), on its own so callers can have the search
 * without the crawler.
 *
 * It used to live in `minimize.ts`, which imports `ChaosCrawler` — and
 * therefore Playwright — at module scope. That is fine for the trace CLI that
 * needs a browser anyway, but `model/shrink.ts` is browser-free by design, and
 * an import that drags Chromium in behind a pure function is how a module stops
 * being unit-testable. `minimize.ts` re-exports this, so the published name is
 * unchanged.
 */

/**
 * Narrows `items` down to the minimal subsequence that still satisfies
 * `predicate` ("this reproduces the failure"). `predicate` should return `true`
 * when the subset still reproduces, `false` otherwise.
 *
 * The algorithm preserves order and is deterministic given a deterministic
 * predicate. Complexity is O(n log n) in the happy case and O(n²) worst case.
 *
 * The predicate is two-valued and has no way to say "I could not tell", so a
 * caller whose oracle has that third answer must not fold it into a boolean
 * here — it should throw out of the predicate and report why, as
 * `model/shrink.ts` does. Folding it into `false` shrinks past a real minimum;
 * folding it into `true` keeps items on no evidence.
 */
export async function ddmin<T>(
  items: readonly T[],
  predicate: (subset: T[]) => Promise<boolean>,
  onStep?: (info: { iteration: number; size: number; keptAfter: number }) => void
): Promise<T[]> {
  let current: T[] = [...items];
  let granularity = 2;
  let iteration = 0;

  while (current.length >= 2) {
    const chunkSize = Math.ceil(current.length / granularity);
    const chunks: T[][] = [];
    for (let i = 0; i < current.length; i += chunkSize) {
      chunks.push(current.slice(i, i + chunkSize));
    }

    let reduced = false;

    // Phase 1 — try each chunk alone.
    for (const chunk of chunks) {
      iteration++;
      if (await predicate(chunk)) {
        onStep?.({ iteration, size: current.length, keptAfter: chunk.length });
        current = chunk;
        granularity = 2;
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    // Phase 2 — try each complement (drop one chunk at a time).
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!;
      const chunkStart = ci * chunkSize;
      const complement = [
        ...current.slice(0, chunkStart),
        ...current.slice(chunkStart + chunk.length),
      ];
      if (complement.length === 0) continue;
      iteration++;
      if (await predicate(complement)) {
        onStep?.({ iteration, size: current.length, keptAfter: complement.length });
        current = complement;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    // Phase 3 — increase granularity. If we can't split finer, we're 1-minimal.
    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }

  return current;
}
