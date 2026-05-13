/**
 * Field-value provider abstraction. Drivers that fill form fields
 * (`formDriver`, `payloadDriver`) delegate value generation to a
 * `FieldValueProvider` so payload strategies can be swapped without
 * forking the driver itself.
 *
 * The provider sees structured field metadata (HTML input attributes
 * plus accessible name / placeholder) and returns one value string per
 * call. Returning `null` skips the field — useful when a payload set
 * only targets one type (e.g. URL-only SSRF payloads).
 */
import type { Rng } from "../random.js";

export interface FormFieldInfo {
  /** Playwright selector. */
  selector: string;
  /** Accessible name / label / aria-label. Most useful field metadata. */
  name?: string;
  /**
   * Input element type (text / email / number / url / tel / search /
   * password / date / textarea / select / checkbox / radio). For non-input
   * tags the tag name is used.
   */
  inputType?: string;
  /** `placeholder` attribute, if present. */
  placeholder?: string;
  /** `pattern` regexp string (HTML5 form validation). */
  pattern?: string;
  /** `minlength` / `maxlength`. */
  minLength?: number;
  maxLength?: number;
  /** `min` / `max` for numeric / date inputs. */
  min?: string;
  max?: string;
  /** `required` flag. */
  required?: boolean;
  /** Available `<option value>` strings, for `<select>`. */
  options?: string[];
}

export interface FieldValueProvider {
  readonly name: string;
  /**
   * Return a string value to type into the field, `null` to skip it.
   * For boolean inputs (checkbox/radio), returning a non-null string
   * means "check it"; the driver translates that into the right
   * playwright call.
   */
  valueFor(field: FormFieldInfo, rng: Rng): string | null;
}

const LONG_STRING = "A".repeat(2048);
const UNICODE_EDGE = "🙂‮​﻿Ａ𝕏ｱあ";
const EMOJI_HEAVY = "😀😡🔥💥🚀".repeat(10);

/**
 * Default provider — sensible-looking values per input type. Picks
 * randomly from a small set so a single page repetition can still
 * produce variety.
 */
export function defaultValueProvider(): FieldValueProvider {
  return {
    name: "default",
    valueFor(field, rng) {
      switch ((field.inputType ?? "text").toLowerCase()) {
        case "email":
          return pick(rng, ["test@example.com", "qa+bug@example.test", "user@localhost"]);
        case "url":
          return pick(rng, ["https://example.com", "https://localhost", "http://127.0.0.1"]);
        case "tel":
          return pick(rng, ["+15555550100", "090-1234-5678"]);
        case "number":
          return pick(rng, ["0", "1", "-1", "42"]);
        case "date":
          return pick(rng, ["2024-01-01", "1999-12-31"]);
        case "password":
          return pick(rng, ["P@ssw0rd!", "hunter2"]);
        case "search":
        case "text":
        case "textarea":
          return pick(rng, ["chaos", "test input", "Hello, world!", "a"]);
        case "checkbox":
        case "radio":
          return "checked";
        case "select":
          if (field.options && field.options.length > 0) {
            return field.options[Math.floor(rng.next() * field.options.length)] ?? null;
          }
          return null;
        default:
          return pick(rng, ["test"]);
      }
    },
  };
}

/**
 * Boundary-value provider — picks empty, very-long, zero/negative,
 * unicode edge-cases. Pairs well with invariants that look for crashes
 * or 500s. Skips checkbox/radio (they have no scalar boundary).
 */
export function boundaryValueProvider(): FieldValueProvider {
  return {
    name: "boundary",
    valueFor(field, rng) {
      const t = (field.inputType ?? "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return "checked";
      if (t === "select") {
        return field.options?.[0] ?? null;
      }
      const candidates: string[] = [];
      candidates.push("");
      if (field.maxLength !== undefined && field.maxLength > 0) {
        candidates.push("A".repeat(field.maxLength));
        candidates.push("A".repeat(field.maxLength + 1));
      } else {
        candidates.push(LONG_STRING);
      }
      if (t === "number") {
        candidates.push("0", "-1", "999999999999999", "NaN", "Infinity");
      }
      if (t === "email") {
        candidates.push("not-an-email", "@", "a@b", "test@");
      }
      if (t === "url") {
        candidates.push("not a url", "javascript:alert(1)", "file:///etc/passwd");
      }
      if (t === "date") {
        candidates.push("0000-00-00", "9999-12-31", "not-a-date");
      }
      candidates.push(UNICODE_EDGE, EMOJI_HEAVY);
      return candidates[Math.floor(rng.next() * candidates.length)] ?? "";
    },
  };
}

/**
 * Wrap a provider so it returns one fixed value for the next call to
 * `valueFor`, then falls through to the wrapped provider. Used by
 * `payloadDriver` to inject a chosen payload while keeping defaults
 * for the rest of the form.
 */
export function fromList(name: string, values: ReadonlyArray<string>): FieldValueProvider {
  if (values.length === 0) {
    throw new Error("fromList: values is empty");
  }
  return {
    name,
    valueFor(field, rng) {
      // For non-text-ish inputs, fall back to neutral defaults so we don't
      // try to write XSS into a checkbox.
      const t = (field.inputType ?? "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return "checked";
      if (t === "select") return field.options?.[0] ?? null;
      return values[Math.floor(rng.next() * values.length)] ?? null;
    },
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng.next() * items.length)] as T;
}
