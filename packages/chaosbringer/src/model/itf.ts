/**
 * ITF (Informal Trace Format) reader.
 *
 * ITF is what Quint and Apalache emit for a trace — `quint run --out-itf`,
 * `quint verify --out-itf`, or an Apalache counterexample. Spec:
 * https://apalache-mc.org/docs/adr/015adr-trace.html
 *
 * Only the shapes a fault model needs are decoded, and everything here is
 * pure so the model→plan path is testable from fixture JSON with no browser
 * and no Quint install:
 *
 *   - `{ "#map": [[k, v], …] }`   → `Map`-like `Record<string, ItfValue>`
 *   - `{ "#tup": [a, b] }`        → array
 *   - `{ "#set": [a, b] }`        → array (order as emitted)
 *   - `{ "#bigint": "42" }`       → number (throws past MAX_SAFE_INTEGER)
 *   - `{ "tag": "Some", "value": … }` → variant, kept as `{ tag, value }`
 *   - plain string / number / boolean / array / record → as-is
 *
 * `mbt::actionTaken` / `mbt::nondetPicks` (from `quint run --mbt`) are
 * surfaced as `action` / `picks` on each decoded state, so a compiler can
 * read which action fired instead of diffing state.
 */

/** Anything an ITF state variable can hold after decoding. */
export type ItfValue =
  | string
  | number
  | boolean
  | null
  | ItfValue[]
  | { tag: string; value: ItfValue }
  | { [key: string]: ItfValue };

export interface ItfState {
  /** 0-based index within the trace. */
  index: number;
  /** Decoded state variables, keyed by name. */
  vars: Record<string, ItfValue>;
  /** `mbt::actionTaken`, when the trace was produced with `--mbt`. */
  action?: string;
  /** `mbt::nondetPicks`, when present. Variant wrappers are unwrapped. */
  picks?: Record<string, ItfValue>;
}

export interface ItfTrace {
  /** `#meta.source` — the spec file the trace came from, when recorded. */
  source?: string;
  /** `#meta.status` — e.g. "violation" for a counterexample. */
  status?: string;
  /** Declared variable names, in the order the producer listed them. */
  varNames: string[];
  states: ItfState[];
}

const MBT_ACTION = "mbt::actionTaken";
const MBT_PICKS = "mbt::nondetPicks";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode one ITF value. Unknown `#`-tagged shapes throw rather than silently degrade. */
export function decodeItfValue(raw: unknown): ItfValue {
  if (raw === null) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return raw;
  }
  if (Array.isArray(raw)) return raw.map(decodeItfValue);
  if (!isRecord(raw)) {
    throw new Error(`chaosbringer/model: unsupported ITF value ${JSON.stringify(raw)}`);
  }

  if ("#map" in raw) {
    const entries = raw["#map"];
    if (!Array.isArray(entries)) {
      throw new Error(`chaosbringer/model: "#map" must be an array of pairs`);
    }
    const out: Record<string, ItfValue> = {};
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(`chaosbringer/model: "#map" entries must be [key, value] pairs`);
      }
      const key = pair[0];
      // Map keys can be non-strings in ITF (tuples, ints). Stringify them the
      // same way a reader would print them, so lookups stay predictable.
      const keyStr = typeof key === "string" ? key : JSON.stringify(decodeItfValue(key));
      out[keyStr] = decodeItfValue(pair[1]);
    }
    return out;
  }
  if ("#tup" in raw) {
    const items = raw["#tup"];
    if (!Array.isArray(items)) throw new Error(`chaosbringer/model: "#tup" must be an array`);
    return items.map(decodeItfValue);
  }
  if ("#set" in raw) {
    const items = raw["#set"];
    if (!Array.isArray(items)) throw new Error(`chaosbringer/model: "#set" must be an array`);
    return items.map(decodeItfValue);
  }
  if ("#bigint" in raw) {
    const n = Number(raw["#bigint"]);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `chaosbringer/model: "#bigint" ${JSON.stringify(raw["#bigint"])} exceeds safe integer range`,
      );
    }
    return n;
  }
  if ("#unserializable" in raw) {
    throw new Error(
      `chaosbringer/model: trace contains an unserializable value — narrow the spec's state before exporting`,
    );
  }
  // Quint sum types: { tag, value }.
  if ("tag" in raw && "value" in raw && typeof raw.tag === "string") {
    return { tag: raw.tag, value: decodeItfValue(raw.value) };
  }

  const out: Record<string, ItfValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("#")) continue; // metadata, not state
    out[k] = decodeItfValue(v);
  }
  return out;
}

/** Unwrap a Quint `Option`-shaped variant to its payload (`None` → null). */
export function unwrapVariant(v: ItfValue): ItfValue {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "tag" in v && "value" in v) {
    const tag = (v as { tag: string }).tag;
    if (tag === "None") return null;
    return (v as { value: ItfValue }).value;
  }
  return v;
}

/** Parse a whole ITF document (already `JSON.parse`d). */
export function parseItfTrace(doc: unknown): ItfTrace {
  if (!isRecord(doc)) throw new Error(`chaosbringer/model: ITF document must be an object`);
  const rawStates = doc.states;
  if (!Array.isArray(rawStates) || rawStates.length === 0) {
    throw new Error(`chaosbringer/model: ITF document has no "states"`);
  }
  const meta = isRecord(doc["#meta"]) ? doc["#meta"] : {};
  const varNames = Array.isArray(doc.vars) ? doc.vars.filter((v): v is string => typeof v === "string") : [];

  const states: ItfState[] = rawStates.map((raw, i) => {
    if (!isRecord(raw)) {
      throw new Error(`chaosbringer/model: ITF state ${i} is not an object`);
    }
    const stateMeta = isRecord(raw["#meta"]) ? raw["#meta"] : {};
    const index = typeof stateMeta.index === "number" ? stateMeta.index : i;

    const vars: Record<string, ItfValue> = {};
    let action: string | undefined;
    let picks: Record<string, ItfValue> | undefined;
    for (const [key, value] of Object.entries(raw)) {
      if (key === "#meta") continue;
      if (key === MBT_ACTION) {
        if (typeof value === "string") action = value;
        continue;
      }
      if (key === MBT_PICKS) {
        const decoded = decodeItfValue(value);
        if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
          picks = {};
          for (const [pk, pv] of Object.entries(decoded as Record<string, ItfValue>)) {
            picks[pk] = unwrapVariant(pv);
          }
        }
        continue;
      }
      vars[key] = decodeItfValue(value);
    }
    const state: ItfState = { index, vars };
    if (action !== undefined) state.action = action;
    if (picks !== undefined) state.picks = picks;
    return state;
  });

  const trace: ItfTrace = { varNames, states };
  if (typeof meta.source === "string") trace.source = meta.source;
  if (typeof meta.status === "string") trace.status = meta.status;
  return trace;
}

/** Convenience: parse from a JSON string. */
export function parseItfJson(json: string): ItfTrace {
  return parseItfTrace(JSON.parse(json));
}

/** The trace's final state — where a witness's outcome lives. */
export function finalState(trace: ItfTrace): ItfState {
  return trace.states[trace.states.length - 1]!;
}

/** Read a string variable from a state, or undefined when absent / not a string. */
export function readString(state: ItfState, name: string): string | undefined {
  const v = state.vars[name];
  return typeof v === "string" ? v : undefined;
}

/** Read a boolean variable from a state, or undefined when absent / not a boolean. */
export function readBool(state: ItfState, name: string): boolean | undefined {
  const v = state.vars[name];
  return typeof v === "boolean" ? v : undefined;
}
