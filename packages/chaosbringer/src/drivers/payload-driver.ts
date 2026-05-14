/**
 * `payloadDriver` — adversarial counterpart of `formDriver`. Same form
 * detection + fill + submit pipeline, but the value provider injects
 * attack payloads (XSS, SQLi, path traversal, oversized strings,
 * unicode edge cases). Intended for **authorized security testing of
 * your own application** — pair with invariants that detect each
 * attack class (see `payloads.ts`).
 *
 * Built on top of `formDriver` to keep the form-detection logic in one
 * place; this module only swaps in the value provider.
 */
import { fromList, type FieldValueProvider } from "./field-values.js";
import { formDriver, type FormDriverOptions } from "./form-driver.js";
import {
  combinePayloadSets,
  DEFAULT_PAYLOAD_SETS,
  type PayloadSetName,
} from "./payloads.js";
import type { Driver } from "./types.js";

export interface PayloadDriverOptions extends Omit<FormDriverOptions, "valueProvider" | "name"> {
  /**
   * Which payload sets to draw from. Either a list of names from the
   * built-in registry (`["xss", "sqli"]`) or a custom array of strings.
   * Default: `["xss", "sqli", "path-traversal", "large", "unicode"]`.
   */
  payloads?: ReadonlyArray<PayloadSetName> | ReadonlyArray<string>;
  /** Override the inner value provider entirely (advanced). */
  valueProvider?: FieldValueProvider;
  name?: string;
}

const DEFAULT_SETS: ReadonlyArray<PayloadSetName> = [
  "xss",
  "sqli",
  "path-traversal",
  "large",
  "unicode",
];

function isNamedSet(p: ReadonlyArray<string>): p is ReadonlyArray<PayloadSetName> {
  return p.every((s) => Object.hasOwn(DEFAULT_PAYLOAD_SETS, s));
}

function resolvePayloads(opt: PayloadDriverOptions["payloads"]): ReadonlyArray<string> {
  if (!opt) return combinePayloadSets(DEFAULT_SETS);
  if (opt.length === 0) return combinePayloadSets(DEFAULT_SETS);
  if (isNamedSet(opt)) return combinePayloadSets(opt);
  return opt;
}

export function payloadDriver(options: PayloadDriverOptions = {}): Driver {
  const payloads = resolvePayloads(options.payloads);
  const provider = options.valueProvider ?? fromList("payloads", payloads);
  const inner = formDriver({
    ...options,
    valueProvider: provider,
    name: options.name ?? `payload(${provider.name})`,
  });
  return inner;
}
