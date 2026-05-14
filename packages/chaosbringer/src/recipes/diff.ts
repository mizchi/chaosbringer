/**
 * Recipe-to-recipe diff. Two distinct shapes:
 *
 *   - **Step diff** — Myers-style LCS over the JSON-encoded step
 *     sequence. Output is a unified-diff-ish block where added /
 *     removed steps are tagged and surrounding context is preserved.
 *     This is the form humans want when reading "what changed in v3?"
 *     during a PR review.
 *
 *   - **Field diff** — flat key/value comparison of the recipe's
 *     metadata (status, origin, postconditions, etc.). Surfaces
 *     classification changes (e.g. demote → verified) that the step
 *     diff hides because step-level JSON is unchanged.
 *
 * Designed to operate on plain `ActionRecipe` JSON — no Playwright,
 * no IO. The CLI just loads two recipes (`name@vM`, `name@vN`, or
 * `nameA`, `nameB`) and pipes them in.
 */
import type { ActionRecipe, RecipeStep } from "./types.js";

export type DiffOp = "equal" | "add" | "remove";

export interface StepDiffEntry {
  op: DiffOp;
  /** Index in the LEFT recipe (or -1 when op === "add"). */
  leftIndex: number;
  /** Index in the RIGHT recipe (or -1 when op === "remove"). */
  rightIndex: number;
  /** Canonical JSON of the step. */
  json: string;
}

export interface FieldDiffEntry {
  field: string;
  left: unknown;
  right: unknown;
}

export interface RecipeDiff {
  left: { name: string; version: number };
  right: { name: string; version: number };
  steps: StepDiffEntry[];
  fields: FieldDiffEntry[];
  /** True when steps + tracked fields are identical. */
  identical: boolean;
}

const TRACKED_FIELDS: ReadonlyArray<keyof ActionRecipe> = [
  "description",
  "goal",
  "origin",
  "status",
  "preconditions",
  "postconditions",
  "requires",
];

export function diffRecipes(left: ActionRecipe, right: ActionRecipe): RecipeDiff {
  const steps = diffSteps(left.steps, right.steps);
  const fields = diffFields(left, right);
  const identical = steps.every((s) => s.op === "equal") && fields.length === 0;
  return {
    left: { name: left.name, version: left.version },
    right: { name: right.name, version: right.version },
    steps,
    fields,
    identical,
  };
}

function diffSteps(
  left: ReadonlyArray<RecipeStep>,
  right: ReadonlyArray<RecipeStep>,
): StepDiffEntry[] {
  const leftJson = left.map(canonicaliseStep);
  const rightJson = right.map(canonicaliseStep);
  const trace = lcs(leftJson, rightJson);
  const out: StepDiffEntry[] = [];
  let i = 0;
  let j = 0;
  for (const op of trace) {
    if (op === "equal") {
      out.push({ op, leftIndex: i, rightIndex: j, json: leftJson[i]! });
      i++;
      j++;
    } else if (op === "remove") {
      out.push({ op, leftIndex: i, rightIndex: -1, json: leftJson[i]! });
      i++;
    } else {
      out.push({ op, leftIndex: -1, rightIndex: j, json: rightJson[j]! });
      j++;
    }
  }
  return out;
}

function diffFields(left: ActionRecipe, right: ActionRecipe): FieldDiffEntry[] {
  const out: FieldDiffEntry[] = [];
  for (const f of TRACKED_FIELDS) {
    const l = left[f];
    const r = right[f];
    if (canonicalJson(l) !== canonicalJson(r)) {
      out.push({ field: f, left: l, right: r });
    }
  }
  return out;
}

/**
 * Standard Myers LCS table → diff op trace. O(N*M) memory; recipes
 * are small (typical N < 30 steps) so this is fine.
 */
function lcs(left: ReadonlyArray<string>, right: ReadonlyArray<string>): DiffOp[] {
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (left[i - 1] === right[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      ops.push("equal");
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push("remove");
      i--;
    } else {
      ops.push("add");
      j--;
    }
  }
  while (i > 0) { ops.push("remove"); i--; }
  while (j > 0) { ops.push("add"); j--; }
  return ops.reverse();
}

function canonicaliseStep(step: RecipeStep): string {
  return canonicalJson(step);
}

/**
 * JSON.stringify with sorted keys at every nesting level. Necessary
 * for `diffFields` — postconditions / preconditions are nested objects
 * and a key-order swap would otherwise be a phantom diff.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export interface FormatDiffOptions {
  /** Show N equal steps on either side of a change. Default: 1. */
  context?: number;
  /** Use ANSI colour codes. Default: false. */
  color?: boolean;
}

/**
 * Render a `RecipeDiff` as a unified-diff-style text block. Equal
 * regions outside the context window collapse to `... (k unchanged)`.
 */
export function formatRecipeDiff(diff: RecipeDiff, opts: FormatDiffOptions = {}): string {
  const ctx = opts.context ?? 1;
  const color = opts.color ?? false;
  const red = (s: string): string => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const green = (s: string): string => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const dim = (s: string): string => (color ? `\x1b[2m${s}\x1b[0m` : s);

  const out: string[] = [];
  const leftLabel = `${diff.left.name}@v${diff.left.version}`;
  const rightLabel = `${diff.right.name}@v${diff.right.version}`;
  out.push(`--- ${leftLabel}`);
  out.push(`+++ ${rightLabel}`);

  if (diff.steps.length === 0) {
    out.push(dim("(both recipes have zero steps)"));
  } else {
    // One pass marks each index that sits within `ctx` of a change.
    // The previous implementation scanned every change index per step,
    // which was O(steps × changes) — fine for recipes today but
    // gratuitous when the fix is straightforward.
    const nearChange = new Array<boolean>(diff.steps.length).fill(false);
    diff.steps.forEach((s, i) => {
      if (s.op === "equal") return;
      for (let j = Math.max(0, i - ctx); j <= Math.min(diff.steps.length - 1, i + ctx); j++) {
        nearChange[j] = true;
      }
    });
    if (nearChange.every((v) => !v)) {
      out.push(dim("(no step changes)"));
    } else {
      let lastPrinted = -1;
      diff.steps.forEach((entry, idx) => {
        if (!nearChange[idx]) return;
        if (lastPrinted >= 0 && idx - lastPrinted > 1) {
          out.push(dim(`... (${idx - lastPrinted - 1} unchanged)`));
        }
        if (entry.op === "equal") out.push(`  ${entry.json}`);
        else if (entry.op === "remove") out.push(red(`- ${entry.json}`));
        else out.push(green(`+ ${entry.json}`));
        lastPrinted = idx;
      });
      const trailing = diff.steps.length - 1 - lastPrinted;
      if (trailing > 0) out.push(dim(`... (${trailing} unchanged)`));
    }
  }

  if (diff.fields.length > 0) {
    out.push("");
    out.push("Field changes:");
    for (const f of diff.fields) {
      out.push(`  ${f.field}:`);
      out.push(red(`    - ${JSON.stringify(f.left)}`));
      out.push(green(`    + ${JSON.stringify(f.right)}`));
    }
  }

  return out.join("\n");
}
