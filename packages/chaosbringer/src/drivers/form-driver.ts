/**
 * Form-aware driver. When the current page has at least one fillable
 * `<form>` element, this driver fills every supported field with a
 * value from a `FieldValueProvider` and submits the form — all in a
 * single chaos action. Pair with invariants that look for 5xx /
 * unhandled rejections to catch validation-bypass regressions.
 *
 * Returns `null` (defer) when there is no form on the page or every
 * form is empty / hidden, so it composes cleanly under
 * `compositeDriver([formDriver(), weightedRandomDriver()])`.
 */
import type { ElementHandle, Page } from "playwright";
import type { ActionResult } from "../types.js";
import { defaultValueProvider, type FieldValueProvider, type FormFieldInfo } from "./field-values.js";
import type { Driver, DriverPick, DriverStep } from "./types.js";

export interface FormDriverOptions {
  /** Value provider for each field. Default: `defaultValueProvider()`. */
  valueProvider?: FieldValueProvider;
  /**
   * How to commit the form. `auto` tries a submit button first, then
   * pressing Enter inside the first text field. Default: `auto`.
   */
  submitStrategy?: "auto" | "click-submit" | "press-enter" | "no-submit";
  /**
   * Skip when the page has no form. Default: true. Set false to make
   * the driver explicit-only (returns null instead of skip when no form).
   */
  deferWhenNoForm?: boolean;
  /** Max fields to fill per form. Avoids enormous forms eating the step. Default: 20. */
  maxFieldsPerForm?: number;
  /** Optional CSS scope; only consider forms matching this selector. */
  formSelector?: string;
  name?: string;
}

interface FormDescription {
  formSelector: string;
  fields: ReadonlyArray<FormFieldInfo>;
  submitSelector: string | null;
}

const FIELD_QUERY = "input:not([type=hidden]):not([disabled]),textarea:not([disabled]),select:not([disabled])";

export function formDriver(opts: FormDriverOptions = {}): Driver {
  const provider = opts.valueProvider ?? defaultValueProvider();
  const submitStrategy = opts.submitStrategy ?? "auto";
  const deferWhenNoForm = opts.deferWhenNoForm ?? true;
  const maxFields = opts.maxFieldsPerForm ?? 20;
  const formSelector = opts.formSelector ?? "form";

  return {
    name: opts.name ?? `form(${provider.name})`,

    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      const form = await pickForm(step.page, formSelector, maxFields);
      if (form === null) {
        return deferWhenNoForm ? null : { kind: "skip" };
      }

      const plan = form.fields.flatMap<{ field: FormFieldInfo; value: string }>((f) => {
        const v = provider.valueFor(f, step.rng);
        return v === null ? [] : [{ field: f, value: v }];
      });
      if (plan.length === 0) {
        return deferWhenNoForm ? null : { kind: "skip" };
      }

      const reasoning = `${provider.name}: ${plan.length} field(s)`;
      return {
        kind: "custom",
        source: `form/${provider.name}`,
        reasoning,
        async perform(page): Promise<ActionResult> {
          const timestamp = Date.now();
          const filled: string[] = [];
          try {
            for (const { field, value } of plan) {
              const locator = page.locator(field.selector).first();
              if ((await locator.count()) === 0) continue;
              await fillField(page, field, value);
              filled.push(field.name ?? field.selector);
            }
            const submitted = await submit(page, form, submitStrategy);
            return {
              type: "input",
              target: describeForm(form, filled, submitted),
              selector: form.formSelector,
              success: true,
              timestamp,
            };
          } catch (err) {
            return {
              type: "input",
              target: describeForm(form, filled, false),
              selector: form.formSelector,
              success: false,
              error: err instanceof Error ? err.message : String(err),
              timestamp,
            };
          }
        },
      };
    },
  };
}

async function pickForm(
  page: Page,
  formSelector: string,
  maxFields: number,
): Promise<FormDescription | null> {
  const forms = await page.$$(formSelector);
  for (const form of forms) {
    if (!(await isVisible(form))) continue;
    const description = await describeFormHandle(form, maxFields);
    if (description !== null && description.fields.length > 0) {
      return description;
    }
  }
  return null;
}

async function isVisible(handle: ElementHandle<Element>): Promise<boolean> {
  try {
    return await handle.evaluate((el) => {
      const e = el as HTMLElement;
      const rect = e.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  } catch {
    return false;
  }
}

async function describeFormHandle(
  form: ElementHandle<Element>,
  maxFields: number,
): Promise<FormDescription | null> {
  type FieldDesc = Omit<FormFieldInfo, "selector"> & { id: string };
  let formId: string;
  try {
    formId = await form.evaluate((el, attr) => {
      const e = el as HTMLFormElement;
      if (e.id) return `#${e.id}`;
      if (e.name) return `form[name="${e.name}"]`;
      const all = Array.from(document.querySelectorAll("form"));
      const idx = all.indexOf(e);
      return `${attr}:nth-of-type(${idx + 1})`;
    }, "form");
  } catch {
    return null;
  }

  let fieldDescs: FieldDesc[];
  try {
    fieldDescs = await form.evaluate((el, args) => {
      const root = el as HTMLFormElement;
      const nodes = Array.from(root.querySelectorAll(args.fieldQuery)) as HTMLElement[];
      const out: Array<Omit<FormFieldInfo, "selector"> & { id: string }> = [];
      for (let i = 0; i < nodes.length && out.length < args.max; i++) {
        const n = nodes[i] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const tag = n.tagName.toLowerCase();
        const type = tag === "input" ? (n as HTMLInputElement).type.toLowerCase() : tag;
        const name = n.getAttribute("aria-label")
          ?? n.getAttribute("name")
          ?? (n.id ? `${tag}#${n.id}` : undefined)
          ?? n.getAttribute("placeholder")
          ?? undefined;
        // Build a stable selector — prefer id, then name+form scoping.
        let id = "";
        if (n.id) id = `#${CSS.escape(n.id)}`;
        else if ((n as HTMLInputElement).name) {
          id = `${tag}[name="${(n as HTMLInputElement).name}"]`;
        } else {
          id = `${tag}:nth-of-type(${i + 1})`;
        }
        const desc: Omit<FormFieldInfo, "selector"> & { id: string } = { id, inputType: type, name };
        const placeholder = n.getAttribute("placeholder");
        if (placeholder) desc.placeholder = placeholder;
        const pattern = n.getAttribute("pattern");
        if (pattern) desc.pattern = pattern;
        const required = n.hasAttribute("required");
        if (required) desc.required = true;
        const minLen = n.getAttribute("minlength");
        if (minLen) desc.minLength = Number(minLen);
        const maxLen = n.getAttribute("maxlength");
        if (maxLen) desc.maxLength = Number(maxLen);
        const min = n.getAttribute("min");
        if (min !== null) desc.min = min;
        const max = n.getAttribute("max");
        if (max !== null) desc.max = max;
        if (tag === "select") {
          desc.options = Array.from((n as HTMLSelectElement).options).map((o) => o.value);
        }
        out.push(desc);
      }
      return out;
    }, { fieldQuery: FIELD_QUERY, max: maxFields });
  } catch {
    return null;
  }

  let submitSelector: string | null = null;
  try {
    submitSelector = await form.evaluate((el) => {
      const e = el as HTMLFormElement;
      const candidates = Array.from(
        e.querySelectorAll('button[type=submit], input[type=submit], button:not([type])'),
      );
      const visible = candidates.find((c) => {
        const r = (c as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!visible) return null;
      const id = (visible as HTMLElement).id;
      if (id) return `#${id}`;
      const tag = visible.tagName.toLowerCase();
      const name = visible.getAttribute("name");
      if (name) return `${tag}[name="${name}"]`;
      return null; // fall through — driver will use a more generic locator
    });
  } catch {
    submitSelector = null;
  }

  const fields: FormFieldInfo[] = fieldDescs.map((d) => {
    const { id, ...rest } = d;
    return { ...rest, selector: `${formId} ${id}` };
  });

  return { formSelector: formId, fields, submitSelector };
}

async function fillField(page: Page, field: FormFieldInfo, value: string): Promise<void> {
  const locator = page.locator(field.selector).first();
  const t = (field.inputType ?? "text").toLowerCase();
  if (t === "checkbox" || t === "radio") {
    await locator.check({ timeout: 1000 }).catch(async () => {
      // Some radio implementations need click instead of check.
      await locator.click({ timeout: 1000 });
    });
    return;
  }
  if (t === "select") {
    await locator.selectOption(value, { timeout: 1000 });
    return;
  }
  await locator.fill(value, { timeout: 1000 });
}

async function submit(
  page: Page,
  form: FormDescription,
  strategy: NonNullable<FormDriverOptions["submitStrategy"]>,
): Promise<boolean> {
  if (strategy === "no-submit") return false;

  if (strategy === "click-submit" || strategy === "auto") {
    if (form.submitSelector) {
      const button = page.locator(form.submitSelector).first();
      if ((await button.count()) > 0) {
        await button.click({ timeout: 1500 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
        return true;
      }
    }
    if (strategy === "click-submit") return false;
  }
  // auto / press-enter fallthrough
  if (form.fields.length > 0) {
    const first = page.locator(form.fields[0]!.selector).first();
    if ((await first.count()) > 0) {
      await first.press("Enter", { timeout: 1000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

function describeForm(form: FormDescription, filled: ReadonlyArray<string>, submitted: boolean): string {
  return `${form.formSelector} [${filled.join(", ")}]${submitted ? " ↵submit" : ""}`;
}
