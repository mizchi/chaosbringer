// The --floor flags and the budgets file of `lightbringer run --emit-budgets /
// --gate`, out of cli.ts so they can be tested: cli.ts parses process.argv and
// starts measuring as soon as it is imported.
import {
  DEFAULT_BUDGET_FLOORS,
  DEFAULT_BUDGET_HEADROOM,
  emitBudgets,
  parseBudgetFloors,
  spanMedians,
  type BudgetFloors,
  type SpanMedians,
} from "./stats";
import type { PerfReport } from "./report-types";

/**
 * Every value of a repeatable `--<name> <v>` / `--<name>=<v>` flag, in order.
 * Throws when a `--<name>` has no value (the last argument, or followed by
 * another flag): `--floor --gate` must not read `--gate` as a floor.
 */
export function flagValues(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith(`--${name}=`)) {
      out.push(a.slice(name.length + 3));
    } else if (a === `--${name}`) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      out.push(v);
      i++;
    }
  }
  return out;
}

/** The emit-budgets floors of `--floor <metric>=<n>` flags over the defaults; throws on a malformed one. */
export function floorsFromArgv(argv: readonly string[]): BudgetFloors {
  return parseBudgetFloors(flagValues(argv, "floor"));
}

/**
 * The key of lightbringer.budgets.json that records how its budgets were
 * emitted. slugify never writes a `$`, so it cannot collide with a slug.
 */
export const EMIT_META_KEY = "$emit";

export interface EmitMeta {
  headroom: number;
  floors: BudgetFloors;
}

/**
 * lightbringer.budgets.json: slug → span → metric → budget, plus `$emit`
 * (`{ headroom, floors }`), absent in files written before it was recorded.
 */
export interface SlugBudgetsFile {
  [EMIT_META_KEY]?: EmitMeta;
  [slug: string]: SpanMedians | EmitMeta | undefined;
}

/** The budgets file of runs grouped by slug, from each slug's medians. */
export function emitSlugBudgets(
  bySlug: ReadonlyMap<string, readonly Pick<PerfReport, "spans">[]>,
  { headroom = DEFAULT_BUDGET_HEADROOM, floors = DEFAULT_BUDGET_FLOORS }: Partial<EmitMeta> = {},
): SlugBudgetsFile {
  const file: SlugBudgetsFile = { [EMIT_META_KEY]: { headroom, floors: { ...floors } } };
  for (const [slug, runs] of bySlug) file[slug] = emitBudgets(spanMedians(runs), { headroom, floors });
  return file;
}

/**
 * One slug's budgets in a budgets file, old or new: `{}` for a slug it has
 * no budgets for. `$emit` is never a slug, so it is never read as budgets.
 */
export function slugBudgets(file: SlugBudgetsFile, slug: string): SpanMedians {
  if (slug === EMIT_META_KEY) return {};
  return (file[slug] as SpanMedians | undefined) ?? {};
}
