/**
 * Refuse raw faults where a *compiled* fault is expected.
 *
 * `compileXFaults()` wraps each fault as `{ fault, name, matched, fired, … }`,
 * and the stats readers take that shape. Handed the originals instead — an
 * easy mistake, since both are "the faults" from the caller's point of view —
 * they produced garbage rather than an error, each in its own way:
 *
 * - `mergeRuntimeStats(rawFaults, …)` returned
 *   `{ rule: "f1", matched: NaN, fired: NaN }`. The label came from the raw
 *   fault's own `name`, so the row looks real, and `NaN > 0` is false: the
 *   "did the fault fire?" check reports "it didn't" rather than "you called
 *   this wrong".
 * - `lifecycleStatsFrom(rawFaults)` returned `[{}]` — every field undefined.
 * - `mergeIframeStats(rawFaults, …)` threw
 *   `Cannot read properties of undefined (reading 'selector')`, which is at
 *   least loud but names nothing a caller can act on.
 *
 * One guard for the three, because the alternative is three near-identical
 * checks and eventually two of them.
 */

/** Fields every `Compiled*Fault` carries and no raw fault does. */
interface CompiledLike {
  fault: unknown;
  name: unknown;
  matched: unknown;
}

function isCompiled(value: unknown): value is CompiledLike {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return "fault" in v && "name" in v && typeof v.matched === "number";
}

/**
 * @param fn - the function being called, for the message.
 * @param compileFn - the name of the compile step the caller skipped.
 */
export function assertCompiledFaults(
  fn: string,
  compileFn: string,
  faults: readonly unknown[],
): void {
  for (const [i, f] of faults.entries()) {
    if (isCompiled(f)) continue;
    const hasAction = f !== null && typeof f === "object" && "action" in f;
    throw new Error(
      `chaosbringer: ${fn} expects the output of ${compileFn}, but index ${i} is ` +
        (hasAction
          ? `a raw fault — pass \`${compileFn}(faults)\`, not \`faults\`. ` +
            `Without the compiled wrapper the counters read as NaN or undefined, which is ` +
            `indistinguishable from "the fault never fired".`
          : `not a compiled fault (no \`fault\`/\`name\`/\`matched\`).`),
    );
  }
}
