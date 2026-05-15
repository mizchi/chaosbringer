/**
 * Localising JSON body drift to specific paths.
 *
 * `parity` and `journey` currently report body mismatches as opaque
 * `left=N bytes, hash=…` pairs. That tells a triager that something
 * changed but not which field — the difference between "0 bytes" of
 * useful signal and "name the bug" depends on this module.
 *
 * Limitations are explicit:
 *
 * - Only JSON. Non-JSON bodies (HTML, binary) fall through with a
 *   single `BodyDiffEntry` describing the type mismatch — better than
 *   silent skip, less work than per-content-type diffing.
 * - Top-down structural walk. Arrays are compared element-by-index;
 *   reordering produces a "wide" diff. Callers that care about set
 *   semantics should sort before comparison.
 * - Outputs are capped at `maxEntries` so a 10k-element list diff
 *   doesn't pollute the report. The cap is documented at the call
 *   site; the truncation is signalled via the `truncated` flag.
 */

export type BodyDiffKind =
  /** Path exists on right but not on left. */
  | "added"
  /** Path exists on left but not on right. */
  | "removed"
  /** Both sides have the path, but the leaf values differ. */
  | "changed"
  /**
   * Both sides have the path; one is a primitive and the other a
   * container (object/array) — a structural shape change. Reported
   * once at the boundary; we don't descend further on this branch.
   */
  | "typed";

export interface BodyDiffEntry {
  /** Dotted path into the tree. Empty string is the root. */
  path: string;
  kind: BodyDiffKind;
  left?: unknown;
  right?: unknown;
}

export interface BodyDiffResult {
  entries: BodyDiffEntry[];
  /** True when the diff was truncated to `maxEntries`. */
  truncated: boolean;
}

interface DiffOptions {
  /** Hard cap on entries. Default 50 — enough to triage, small enough to read. */
  maxEntries?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeTag(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function pushChange(
  out: BodyDiffEntry[],
  cap: number,
  entry: BodyDiffEntry,
): boolean {
  if (out.length >= cap) return true;
  out.push(entry);
  return out.length >= cap;
}

function walk(
  left: unknown,
  right: unknown,
  path: string,
  out: BodyDiffEntry[],
  cap: number,
): boolean {
  // Returns true when the cap has been hit and the caller should stop.
  if (Object.is(left, right)) return out.length >= cap;
  // Primitives + null: bare equality already failed above, so report
  // a change. Strict-equality semantics mean `NaN === NaN` is false
  // by default but `Object.is(NaN, NaN)` is true — using `Object.is`
  // above keeps NaN out of the noise.
  const lt = typeTag(left);
  const rt = typeTag(right);
  if (lt !== rt) {
    return pushChange(out, cap, { path, kind: "typed", left, right });
  }
  if (lt !== "object" && lt !== "array") {
    return pushChange(out, cap, { path, kind: "changed", left, right });
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
      const sub = path ? `${path}.${i}` : String(i);
      if (i >= left.length) {
        if (pushChange(out, cap, { path: sub, kind: "added", right: right[i] })) return true;
        continue;
      }
      if (i >= right.length) {
        if (pushChange(out, cap, { path: sub, kind: "removed", left: left[i] })) return true;
        continue;
      }
      if (walk(left[i], right[i], sub, out, cap)) return true;
    }
    return out.length >= cap;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    // Iterate the union of keys so we surface both directions of drift.
    // Sorted so the report is stable across runs (useful for diffing
    // diffs across CI runs).
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    for (const k of keys) {
      const sub = path ? `${path}.${k}` : k;
      const hasLeft = Object.hasOwn(left, k);
      const hasRight = Object.hasOwn(right, k);
      if (!hasRight) {
        if (pushChange(out, cap, { path: sub, kind: "removed", left: left[k] })) return true;
        continue;
      }
      if (!hasLeft) {
        if (pushChange(out, cap, { path: sub, kind: "added", right: right[k] })) return true;
        continue;
      }
      if (walk(left[k], right[k], sub, out, cap)) return true;
    }
    return out.length >= cap;
  }
  // Should not reach here — primitives are handled above, container
  // types matched. Keep a safe fallback for shapes we didn't anticipate.
  return pushChange(out, cap, { path, kind: "changed", left, right });
}

/**
 * Compute the body diff. Returns `null` (not an empty result) when the
 * bodies are byte-identical — the caller already knows there's no
 * drift in that case. Returns `{ entries: [{ kind: "typed", … }] }`
 * when at least one side isn't parseable JSON: a triager seeing
 * "kind=typed at root, left=object, right=string" learns the
 * content-type drifted without needing the byte hash.
 */
function tryParseJson(text: string | null): { ok: boolean; value?: unknown } {
  if (text === null || text.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function diffJsonBodies(
  leftText: string | null,
  rightText: string | null,
  opts: DiffOptions = {},
): BodyDiffResult | null {
  const cap = opts.maxEntries ?? 50;
  const left = tryParseJson(leftText);
  const right = tryParseJson(rightText);
  // Both bodies aren't JSON → we have nothing structural to add over
  // the hash mismatch. Return null and let the caller fall back to
  // the byte-level summary. Returning a fake "typed string→string"
  // here would be actively misleading.
  if (!left.ok && !right.ok) return null;
  // One side is JSON, the other isn't → that's a real content-type
  // drift the operator should see. Report at the root with the
  // raw values.
  if (!left.ok || !right.ok) {
    return {
      entries: [{ path: "", kind: "typed", left: leftText, right: rightText }],
      truncated: false,
    };
  }
  const entries: BodyDiffEntry[] = [];
  walk(left.value, right.value, "", entries, cap);
  if (entries.length === 0) return null;
  return { entries, truncated: entries.length >= cap };
}

/**
 * One-line summary fit for stdout. Renders up to `limit` entries as
 * `path: <kind> (left=… right=…)`. Returns the empty string when
 * the diff is null.
 */
export function summariseBodyDiff(diff: BodyDiffResult | null | undefined, limit = 3): string {
  if (!diff || diff.entries.length === 0) return "";
  const lines = diff.entries.slice(0, limit).map((e) => {
    const path = e.path === "" ? "(root)" : e.path;
    if (e.kind === "added") return `${path}: +${stringify(e.right)}`;
    if (e.kind === "removed") return `${path}: -${stringify(e.left)}`;
    if (e.kind === "typed") {
      return `${path}: type ${typeTag(e.left)} → ${typeTag(e.right)}`;
    }
    return `${path}: ${stringify(e.left)} → ${stringify(e.right)}`;
  });
  if (diff.entries.length > limit) {
    lines.push(`(+${diff.entries.length - limit} more${diff.truncated ? ", truncated" : ""})`);
  }
  return lines.join(" | ");
}

function stringify(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return String(v);
  }
}
