/**
 * Reading `targets.txt` — the enumeration's own bookkeeping, and the only
 * place the unreachability claim lives.
 *
 * One parser, shared by every runner and every test that reports coverage,
 * because the last time each caller had its own the format moved underneath
 * them: `enumerate.sh` grew `vacuity.mjs --annotate`, which rewrites
 * `unreachable  <name>` into `unreachable-live` / `unreachable-by-construction`,
 * and a runner matching the word `unreachable` exactly reported both rows as
 * **reachable** — the exact inversion of what a `contract-forbids-*` row means.
 * `aggregateCoverage` cannot notice: it is handed the rows already classified.
 *
 * So the rule is here, once: a status *starting* with `unreachable` is
 * unreachable, and the suffix (when there is one) is the vacuity verdict.
 * Anything else is reachable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetOutcome } from "chaosbringer";

/** A `targets.txt` row, with the classification the plain `TargetOutcome` drops. */
export interface TargetRow extends TargetOutcome {
  /**
   * For an unreachable row: whether a witness was ever possible.
   * `undefined` means the row predates `vacuity.mjs --annotate` (or the unit
   * does not call it), which is the state F6 exists to abolish.
   */
  verdict?: "live" | "by-construction";
}

/** Parse the contents of a `targets.txt`. */
export function parseTargets(text: string): TargetRow[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status, name] = line.trim().split(/\s+/);
      const word = status ?? "";
      if (!word.startsWith("unreachable")) {
        return { target: name ?? "?", status: "reachable" as const };
      }
      const suffix = word.slice("unreachable".length).replace(/^-/, "");
      const row: TargetRow = { target: name ?? "?", status: "unreachable" as const };
      if (suffix === "live" || suffix === "by-construction") row.verdict = suffix;
      return row;
    });
}

/** Parse the `targets.txt` of one model unit directory. */
export function loadTargets(unitDir: string): TargetRow[] {
  return parseTargets(readFileSync(join(unitDir, "targets.txt"), "utf8"));
}

/**
 * The depth bound the unit's own `enumerate.sh` used, so a report cannot claim
 * a bound the enumeration did not run at. Same trick `vacuity.mjs` uses for
 * the same reason: two copies of a number drift, a derived one cannot.
 */
export function depthBoundOf(unitDir: string): number | undefined {
  const src = readFileSync(join(unitDir, "enumerate.sh"), "utf8");
  const m = /DEPTH="\$\{DEPTH:-(\d+)\}"/.exec(src);
  return m ? Number(m[1]) : undefined;
}
