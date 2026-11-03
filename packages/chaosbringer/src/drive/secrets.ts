/**
 * What `drive` keeps secret: the values it types into password and
 * one-time-code fields, and the `--secret name=ENV_VAR` values a plan or a
 * model types by name (`{{name}}`).
 *
 * A typed password used to be copied as it was into the recipe, the recipe
 * store, `drive-report.json` (twice) and the progress line on stdout, and the
 * accessibility outline the model read on the next step showed it as the
 * field's value (`textbox "Password": hunter2`). Now:
 *
 * - the recipe holds a placeholder instead (`{{password}}`), which a replay
 *   fills in from its vars (`recipes verify --vars-file`);
 * - every text `drive` writes or sends to the decider has each secret value
 *   replaced by its placeholder: the history, the outline, the candidate
 *   descriptions, problems, URLs, the reasoning. The decider still sees that
 *   the field was filled (`fill textbox "Password" "{{password}}"`);
 * - the real values are only in `DriveResult.secretValues()`, a function so
 *   that `JSON.stringify(result)` (drive-report.json) leaves them out.
 *
 * Names: a field's secret is `password` (type=password, or an autocomplete
 * token ending in `-password`) or `one_time_code` (autocomplete
 * `one-time-code`). The same value typed again (a "confirm password" field)
 * reuses its name; a second distinct value of a kind is `password_2`, then
 * `password_3`. A name a `--secret` took is skipped.
 */

import type { Locator } from "playwright";
import { escapeRegExp } from "../filters.js";
import { hasTemplates, type RecipeVars, substituteString, templateNames } from "../recipes/templating.js";

/** Splits text around its placeholders, keeping them (at the odd indices). */
const PLACEHOLDER_SPLIT = /(\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\})/;

export type SecretFieldKind = "password" | "one_time_code";

/**
 * Whether a field with this `type` and `autocomplete` holds a secret, and
 * which. `null` for any other field.
 */
export function classifySecretField(type: string | null, autocomplete: string | null): SecretFieldKind | null {
  const tokens = (autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.includes("one-time-code")) return "one_time_code";
  if ((type ?? "").toLowerCase() === "password" || tokens.some((t) => t.endsWith("-password"))) return "password";
  return null;
}

/**
 * `classifySecretField` of the element `target` points at, read in the
 * page. `null` when it cannot be read (the action that follows fails on
 * the same element anyway).
 */
export async function secretFieldKind(target: Locator, timeout: number): Promise<SecretFieldKind | null> {
  const attrs = await target
    .evaluate((el) => ({
      type: el instanceof HTMLInputElement ? el.type : el.getAttribute("type"),
      autocomplete: el.getAttribute("autocomplete"),
    }), undefined, { timeout })
    .catch(() => null);
  return attrs ? classifySecretField(attrs.type, attrs.autocomplete) : null;
}

export class DriveSecrets {
  /** name → value, in the order they were added. */
  private readonly values = new Map<string, string>();

  /**
   * `named`: the `--secret` values, by the name a plan or model types them
   * by. Also a run's `secretValues()`, to scrub what a replay with them
   * writes (`drive --chaos`); a number or boolean is kept as the text a
   * replay types for it.
   */
  constructor(named: Readonly<RecipeVars> = {}) {
    for (const [name, value] of Object.entries(named)) this.values.set(name, String(value));
  }

  /** The names a value can be typed by (`{{name}}`). */
  names(): string[] {
    return [...this.values.keys()];
  }

  /** Every secret, as a recipe's vars. */
  vars(): RecipeVars {
    return Object.fromEntries(this.values);
  }

  /**
   * `value` as a recipe records it: each known secret value in it written
   * as its placeholder (longest first, so one value inside another is not
   * split). Placeholders already in it are kept.
   */
  template(value: string): string {
    return this.outsidePlaceholders(value, (part) => {
      let out = part;
      for (const [name, secret] of this.byLength()) out = out.split(secret).join(`{{${name}}}`);
      return out;
    });
  }

  /**
   * The text to type for a recorded `value`: its placeholders filled in.
   * Throws an `UndefinedVariableError` for a name no secret has.
   */
  resolve(value: string): string {
    return hasTemplates(value) ? substituteString(value, this.vars()) : value;
  }

  /**
   * Keep `value`, typed into a `kind` field, as a secret, and return the
   * placeholder to record. A value already kept gets its own name back.
   */
  register(value: string, kind: SecretFieldKind): string {
    for (const [name, secret] of this.values) if (secret === value) return `{{${name}}}`;
    let name: string = kind;
    for (let n = 2; this.values.has(name); n++) name = `${kind}_${n}`;
    this.values.set(name, value);
    return `{{${name}}}`;
  }

  /** Whether `value` uses a placeholder (so what is typed is not what is recorded). */
  isTemplated(value: string): boolean {
    return templateNames(value).length > 0;
  }

  /**
   * `text` with every secret value in it replaced by its placeholder, as it
   * is written and as a URL encodes it (`encodeURIComponent`).
   */
  scrub(text: string): string;
  scrub(text: string | undefined): string | undefined;
  scrub(text: string | undefined): string | undefined {
    if (text === undefined || this.values.size === 0) return text;
    return this.outsidePlaceholders(text, (part) => {
      let out = part;
      for (const [name, secret] of this.byLength()) {
        const forms = [...new Set([secret, encodeURIComponent(secret), encodeURIComponent(secret).replace(/%20/g, "+")])];
        out = out.replace(new RegExp(forms.map((f) => escapeRegExp(f)).join("|"), "g"), `{{${name}}}`);
      }
      return out;
    });
  }

  /**
   * `fn` applied to the text between placeholders, the placeholders kept:
   * a secret `password` must not turn `{{password}}` into `{{{{password}}}}`,
   * and scrubbing scrubbed text changes nothing.
   */
  private outsidePlaceholders(text: string, fn: (part: string) => string): string {
    return text
      .split(PLACEHOLDER_SPLIT)
      .map((part, i) => (i % 2 === 1 ? part : fn(part)))
      .join("");
  }

  private byLength(): Array<[string, string]> {
    return [...this.values].filter(([, v]) => v !== "").sort((a, b) => b[1].length - a[1].length);
  }
}
