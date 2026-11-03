/**
 * `--invariants <names>` and `--data-safety`: the invariant presets the main
 * crawl and `scan` turn on by name. They were library-only: a CLI user had
 * `--strict`, which passes a page that runs an XSS payload or shows
 * `Total: NaN EUR`, and no way to reach the checks that catch either.
 *
 * Out of `cli-crawl-options.ts`, whose `buildInvariants` reads it, so that
 * `repro-command.ts` (which must not count what the flag built as "not
 * expressible on the CLI") and `scan/run.ts` read the same table without the
 * main CLI's option table.
 *
 * Each preset is built with its defaults: the flag takes names, not options.
 * Markers, tokens, `ignore`, `selector`, `urlPattern`, `when` and the rest
 * are set through the library (`invariants.dataSafety({ … })`).
 */
import { UsageError } from "./cli-usage.js";
import { injectedMarkup, notBlank, prototypePollution, renderedGarbage, xssMarker } from "./data-invariants.js";
import type { Invariant } from "./types.js";

/** Each preset by its flag name, in the order they run (`dataSafety()`'s, then `notBlank`). */
const PRESETS = {
  "xss-marker": xssMarker,
  "injected-markup": injectedMarkup,
  "prototype-pollution": prototypePollution,
  "rendered-garbage": renderedGarbage,
  "not-blank": notBlank,
} as const satisfies Record<string, () => Invariant>;

export type InvariantPreset = keyof typeof PRESETS;

export const INVARIANT_PRESETS = Object.keys(PRESETS) as readonly InvariantPreset[];

/**
 * What `data-safety` names: `invariants.dataSafety()`'s four presets. Not
 * `not-blank`, which `dataSafety()` leaves out too: a canvas or image-only
 * page is blank by design.
 */
export const DATA_SAFETY_PRESETS: readonly InvariantPreset[] = ["xss-marker", "injected-markup", "prototype-pollution", "rendered-garbage"];

/** What `ScanOptions.invariants` takes: a preset, or the `data-safety` bundle. */
export type InvariantPresetName = InvariantPreset | "data-safety";

/**
 * Every name `--invariants` takes, as its refusal lists them. `axe` is the
 * `--axe` flag under another name: it builds the same `axe()`, with
 * `--axe-tags`, and needs the same peer.
 */
export const INVARIANT_FLAG_NAMES: readonly string[] = ["data-safety", ...INVARIANT_PRESETS, "axe"];

/** What `--invariants` and `--data-safety` ask for: the presets, de-duplicated, and whether `axe` was named. */
export interface InvariantsFlag {
  presets: InvariantPreset[];
  axe: boolean;
}

const known = () => `known: ${INVARIANT_FLAG_NAMES.join(", ")}`;

/**
 * `names` as the presets they stand for, once each, in `INVARIANT_PRESETS`'
 * order: `data-safety` and one of its members, or a name given twice, run
 * one check, not two. Throws on a name it does not know, which a plain-JS
 * `ScanOptions.invariants` can hold.
 */
export function expandInvariantNames(names: readonly string[]): InvariantPreset[] {
  const wanted = new Set<string>();
  for (const name of names) {
    if (name === "data-safety") for (const p of DATA_SAFETY_PRESETS) wanted.add(p);
    else if (Object.hasOwn(PRESETS, name)) wanted.add(name);
    else throw new UsageError(`--invariants: unknown invariant ${JSON.stringify(name)} (${known()})`);
  }
  return INVARIANT_PRESETS.filter((p) => wanted.has(p));
}

/**
 * Every `--invariants` value (comma lists, the flag repeatable) merged, plus
 * `--data-safety`. A value with no name in it (`--invariants "$CHECKS"`, the
 * variable unset) is refused rather than read as "none".
 */
export function parseInvariantsFlag(values: readonly string[] | undefined, dataSafety = false): InvariantsFlag {
  const names: string[] = dataSafety ? ["data-safety"] : [];
  let axe = false;
  for (const raw of values ?? []) {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) throw new UsageError(`--invariants needs at least one name (${known()})`);
    for (const part of parts) {
      if (part === "axe") axe = true;
      else names.push(part);
    }
  }
  return { presets: expandInvariantNames(names), axe };
}

/** The presets' invariants, each with its defaults. */
export function buildInvariantPresets(presets: readonly InvariantPreset[]): Invariant[] {
  return presets.map((p) => PRESETS[p]());
}

/**
 * `presets` as the one `--invariants` value a Repro line carries: the four
 * of `data-safety` by that name, the rest by theirs, in the table's order,
 * so a command reads back as the run it came from however it was typed.
 */
export function formatInvariantsFlag(presets: readonly InvariantPreset[]): string {
  const set = new Set(expandInvariantNames(presets));
  const bundle = DATA_SAFETY_PRESETS.every((p) => set.has(p));
  const rest = INVARIANT_PRESETS.filter((p) => set.has(p) && !(bundle && DATA_SAFETY_PRESETS.includes(p)));
  return [...(bundle ? ["data-safety"] : []), ...rest].join(",");
}

/** The names of the invariants an `--invariants` value builds (`data.xss-marker`, …); none for one it cannot read. */
export function invariantsFlagBuilds(value: string): string[] {
  try {
    return buildInvariantPresets(parseInvariantsFlag([value]).presets).map((i) => i.name);
  } catch {
    return [];
  }
}
