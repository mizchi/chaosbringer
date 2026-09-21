/**
 * Interactive-element discovery and weighting.
 *
 * Split the same way as `links.ts`, and for the same reason: `collectRawTargets`
 * is shipped into the page by `page.evaluate` and only reads the DOM, while
 * `weighActionTargets` — the policy that decides which elements the crawler is
 * more likely to click — runs in Node. The weighting is where the interesting
 * decisions live (an unvisited link is worth 3x a visited one), so it is the
 * part that most needs to be reachable from a test.
 */

import type { ActionTarget, ActionWeights, TargetGeometry } from "./types.js";
import { escapeSelector, normalizeUrl } from "./filters.js";

/** One interactive element as scraped from the DOM, before any weighting. */
export interface RawActionTarget {
  /** The element's own tag name, lowercased. */
  tag: string;
  /** Visible text content. Empty for form fields, which have none. */
  text: string;
  /** The element's `role` attribute, or null when it has none. */
  role: string | null;
  ariaLabel: string | null;
  /** `placeholder` attribute, for form fields that carry one. */
  placeholder: string | null;
  /** `name` attribute — the most stable handle a form field tends to have. */
  name: string | null;
  index: number;
  hasVisibleText: boolean;
  isNavLink: boolean;
  href?: string;
  isInMainContent: boolean;
  /**
   * Whether Playwright's `fill()` will accept this element at all. A checkbox,
   * a submit button or a `role="textbox"` div that is not contenteditable all
   * throw, and so does a readonly field. They are still worth acting on, just
   * by clicking rather than typing, so the scrape records the fact and leaves
   * the decision to `weighActionTargets`.
   *
   * Note this says nothing about the *value*: a date or range field is
   * fillable, but only with a string of the right shape. `fillValueFor`
   * decides that, from the fields below.
   */
  fillable: boolean;
  /**
   * The effective `type` of an `<input>` — the DOM normalises a missing or
   * unrecognised attribute to "text" — or null for anything that is not an
   * `<input>`. It decides the shape the fill value has to take.
   */
  inputType: string | null;
  /** `min`/`max` attributes, raw. A range field's value must respect them. */
  min: string | null;
  max: string | null;
  /**
   * A `<select>`'s own options, in document order, with the placeholder
   * dropped. Empty for everything else.
   *
   * Read off the page rather than generated, because the value of a
   * dropdown is never the crawler's to invent: the set of legal values is
   * the one the page is offering. `selectValueFor` picks from here.
   */
  options: { value: string; label: string }[];
  /**
   * What a field holds right now. Only used for a `<select>`, where
   * setting the value it already has is an action with no end state.
   */
  currentValue: string | null;
  /**
   * Where the element is and whether a click reaches it. Optional because
   * it is filled in by a pass at the end of the scrape rather than by
   * `push`, and because the hand-built fixtures in the unit tests have no
   * DOM to measure.
   */
  geometry?: TargetGeometry;
}

/**
 * How much of a link's URL the crawler has already seen. The middle case is
 * the one worth naming: a queued-but-unvisited link is neither new ground nor
 * old ground, so it gets neither the boost nor the penalty.
 */
export type UrlFamiliarity = "new" | "queued" | "visited";

/** The crawler state `weighActionTargets` needs, narrowed to what it reads. */
export interface WeightingContext {
  weights: Required<ActionWeights>;
  /** Base used to resolve relative hrefs before asking about familiarity. */
  baseOrigin: string;
  familiarity: (absoluteUrl: string) => UrlFamiliarity;
}

/**
 * Scrape the page's interactive elements.
 *
 * Runs in the browser via `page.evaluate`, so it must stay self-contained: no
 * imports, no references to module scope.
 */
export function collectRawTargets(): RawActionTarget[] {
  const results: RawActionTarget[] = [];
  const elements: Element[] = [];
  const inMainContent = (el: Element) =>
    !!el.closest("main, article, [role='main'], .content, #content");
  /**
   * Record one scraped element; `index` is filled in once all are collected.
   *
   * A disabled control is dropped outright. Playwright will neither click nor
   * fill one, so every attempt costs its full one-second actionability timeout
   * and is then recorded as a failed action against the page under test — the
   * crawler inventing a failure and blaming the app for it. `:disabled` rather
   * than `.disabled` because the IDL property does not reflect the state a
   * control inherits from a disabled <fieldset>, while the pseudo-class does,
   * and matches what Playwright's own actionability check sees.
   */
  const push = (el: Element, t: Omit<RawActionTarget, "index">) => {
    if (el.matches(":disabled")) return;
    elements.push(el);
    results.push({ ...t, index: 0 });
  };

  // Links with priority for navigation
  document.querySelectorAll("a[href]").forEach((el, i) => {
    const anchor = el as HTMLAnchorElement;
    const text = anchor.innerText?.trim() || "";
    const ariaLabel = anchor.getAttribute("aria-label");
    const role = anchor.getAttribute("role");
    // Navigation links are in nav, header, or have specific roles
    const isNavLink = !!anchor.closest("nav, header, [role='navigation']");

    if (text.length < 100 || ariaLabel) {
      push(anchor, {
        tag: "a",
        text,
        role,
        ariaLabel,
        placeholder: null,
        name: null,
        fillable: false,
        inputType: null,
        min: null,
        max: null,
        options: [],
        currentValue: null,
        hasVisibleText: text.length > 0,
        isNavLink,
        href: anchor.href,
        isInMainContent: inMainContent(anchor),
      });
    }
  });

  // Buttons
  document.querySelectorAll("button, [role='button']").forEach((el) => {
    const text = (el as HTMLElement).innerText?.trim() || "";
    const ariaLabel = el.getAttribute("aria-label");

    if (text.length < 100 || ariaLabel) {
      push(el, {
        tag: el.tagName.toLowerCase(),
        text,
        role: el.getAttribute("role"),
        ariaLabel,
        placeholder: null,
        name: null,
        fillable: false,
        inputType: null,
        min: null,
        max: null,
        options: [],
        currentValue: null,
        hasVisibleText: text.length > 0,
        isNavLink: false,
        isInMainContent: inMainContent(el),
      });
    }
  });

  // Interactive ARIA roles
  const ariaSelectors = [
    "[role='menuitem']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='slider']",
    "[role='listbox']",
    "[role='option']",
  ];

  document.querySelectorAll(ariaSelectors.join(", ")).forEach((el) => {
    const text = (el as HTMLElement).innerText?.trim() || "";
    const ariaLabel = el.getAttribute("aria-label");

    push(el, {
      tag: el.tagName.toLowerCase(),
      text,
      role: el.getAttribute("role"),
      ariaLabel,
      placeholder: null,
      name: null,
      fillable: false,
      inputType: null,
      min: null,
      max: null,
      options: [],
      currentValue: null,
      hasVisibleText: text.length > 0,
      isNavLink: false,
      isInMainContent: inMainContent(el),
    });
  });

  // Form fields. Note `text` stays empty even when the field has a label: a
  // selector built from an input's label with `:has-text()` matches nothing,
  // because an <input> has no text content to match against.
  //
  // Every `<input>` type is fillable given a value of the right shape, so the
  // only ones excluded here are those `fill()` refuses outright — the controls
  // you click (checkbox, radio, submit, button, reset, image), the file picker,
  // and readonly fields. `fillValueFor` supplies the shape for the rest.
  const UNFILLABLE_INPUT_TYPES = [
    "checkbox",
    "radio",
    "submit",
    "button",
    "reset",
    "image",
    "file",
    "hidden",
  ];
  document
    .querySelectorAll(
      "input, textarea, [contenteditable], [role='textbox'], [role='searchbox']"
    )
    .forEach((el) => {
      const tag = el.tagName.toLowerCase();
      // `.type` normalises a missing or unrecognised type attribute to "text".
      const inputType = tag === "input" ? (el as HTMLInputElement).type : null;
      const readOnly = (el as HTMLInputElement).readOnly === true;
      const fillable =
        !readOnly &&
        (tag === "textarea" ||
          (el as HTMLElement).isContentEditable ||
          (inputType !== null && UNFILLABLE_INPUT_TYPES.indexOf(inputType) === -1));

      push(el, {
        tag,
        text: "",
        role: el.getAttribute("role"),
        ariaLabel: el.getAttribute("aria-label"),
        placeholder: el.getAttribute("placeholder"),
        name: el.getAttribute("name"),
        fillable,
        inputType,
        min: el.getAttribute("min"),
        max: el.getAttribute("max"),
        options: [],
        currentValue: typeof (el as HTMLInputElement).value === "string"
          ? (el as HTMLInputElement).value
          : null,
        hasVisibleText: false,
        isNavLink: false,
        isInMainContent: inMainContent(el),
      });
    });

  // Dropdowns, which the query above deliberately does not reach: `fill()`
  // refuses a <select>, so it was never a fill target, and nothing else
  // picked it up either — it has no `role` attribute to match the ARIA
  // query and it is not a button.
  //
  // The rest of the library already knows about them: `formDriver`'s
  // FIELD_QUERY includes `select:not([disabled])`, `fillField` calls
  // `selectOption`, `FormFieldInfo` carries `options`,
  // `defaultValueProvider` has a `select` case, and a recipe already has a
  // `{ kind: "select" }` step that `replay` performs. Only this scrape did
  // not, so a driver picking a candidate by index could never set one —
  // the whole form path could, all at once, and nothing else could at all.
  document.querySelectorAll("select").forEach((el) => {
    const select = el as HTMLSelectElement;
    const options: { value: string; label: string }[] = [];
    for (const o of Array.prototype.slice.call(select.options) as HTMLOptionElement[]) {
      // A placeholder is not a value. Offering it back would set the
      // dropdown to nothing, which reads as an action that did something.
      if (o.value === "") continue;
      if (o.disabled) continue;
      options.push({
        value: o.value,
        label: (o.label || o.textContent || o.value).trim(),
      });
    }
    push(select, {
      tag: "select",
      text: "",
      role: select.getAttribute("role"),
      ariaLabel: select.getAttribute("aria-label"),
      placeholder: null,
      name: select.getAttribute("name"),
      // `fill()` throws on a <select>; `selectOption` is the operation.
      fillable: false,
      inputType: null,
      min: null,
      max: null,
      options,
      currentValue: select.value,
      hasVisibleText: false,
      isNavLink: false,
      isInMainContent: inMainContent(select),
    });
  });

  // Number each element within the set its positional selector will count, and
  // only within that set. A per-query counter cannot do this: the ARIA query
  // walks eight roles at once, so its third match may be the page's first
  // [role="slider"], and `:nth-match([role="slider"], 3)` would then resolve to
  // nothing. Matching on the role attribute rather than composing a selector
  // string also keeps a role value containing a quote from breaking the query.
  const roleMatches = (role: string) =>
    Array.prototype.filter.call(
      document.querySelectorAll("[role]"),
      (e: Element) => e.getAttribute("role") === role
    ) as Element[];
  const counted = new Map<string, Element[]>();
  for (let i = 0; i < results.length; i++) {
    const t = results[i]!;
    const key = t.role === null ? `tag:${t.tag}` : `role:${t.role}`;
    let peers = counted.get(key);
    if (!peers) {
      peers = t.role === null
        ? (Array.prototype.slice.call(document.querySelectorAll(t.tag)) as Element[])
        : roleMatches(t.role);
      counted.set(key, peers);
    }
    t.index = peers.indexOf(elements[i]!);
  }

  // Trim first, then measure: the cap is what bounds the hit-test cost, and
  // measuring 300 elements to throw away 250 of them is the one version of
  // this that could show up in a profile.
  const kept = results.slice(0, 50); // Limit to prevent too many targets

  // Geometry last, in one pass, after every DOM read above. `innerText` and
  // `getBoundingClientRect` both force layout, so doing this here rather
  // than inside `push` means the layout computed for the first target is
  // still valid for the fiftieth — nothing between them writes to the DOM.
  //
  // `elementFromPoint` answers the question the descriptions cannot: which
  // element actually receives a click at this spot. It already accounts for
  // `pointer-events`, stacking order and transforms, so there is nothing to
  // reimplement.
  const identify = (el: Element): string => {
    const text = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 60);
    const cls =
      typeof el.className === "string" && el.className.trim().length > 0
        ? `.${el.className.trim().split(/\s+/).join(".")}`
        : "";
    const ident = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : cls}`;
    return text ? `${text} <${ident}>` : `<${ident}>`;
  };
  /**
   * True when `host` is a shadow host the node lives inside.
   * `elementFromPoint` returns the host for a point over shadow content,
   * and `host.contains(inner)` is false because `contains` does not cross
   * shadow boundaries — so without this every control in a web component
   * would report itself covered by its own host.
   */
  const isShadowHostOf = (host: Element, node: Element): boolean => {
    let root: Node = node.getRootNode();
    while ((root as ShadowRoot).host) {
      const h: Element = (root as ShadowRoot).host;
      if (h === host) return true;
      root = h.getRootNode();
    }
    return false;
  };
  for (let i = 0; i < kept.length; i++) {
    const el = elements[i]!;
    const r = el.getBoundingClientRect();
    // The visible part of the box, which is where the probe point goes.
    const x0 = Math.max(r.left, 0);
    const y0 = Math.max(r.top, 0);
    const x1 = Math.min(r.right, window.innerWidth);
    const y1 = Math.min(r.bottom, window.innerHeight);
    const inViewport = x1 > x0 && y1 > y0;
    const style = window.getComputedStyle(el);
    let coveredBy: string | undefined;
    if (inViewport) {
      const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
      // Ancestors are excluded along with descendants. A returned ancestor
      // usually means the target is not hit-testable at that point at all,
      // which is what `inert` is for; calling it "covered" would name the
      // target's own container as the culprit. Under-reporting is the safe
      // direction here — a false "covered" makes a driver skip a control
      // that works.
      if (
        hit &&
        hit !== el &&
        !el.contains(hit) &&
        !hit.contains(el) &&
        !isShadowHostOf(hit, el)
      ) {
        coveredBy = identify(hit);
      }
    }
    kept[i]!.geometry = {
      bbox: { x: r.left, y: r.top, width: r.width, height: r.height },
      inViewport,
      // `pointer-events` only. A low opacity is tempting to fold in here
      // and would be wrong: an `opacity: 0.01` button is fully clickable
      // and the click works, so reporting it as un-clickable is the false
      // positive this file is otherwise careful to avoid. Whether a
      // control is *visible enough for a user to have clicked it* is a
      // different question from whether the click lands, and only the
      // second one belongs in `TargetGeometry`.
      inert: style.pointerEvents === "none",
      ...(coveredBy === undefined ? {} : { coveredBy }),
    };
  }

  return kept;
}

/** What the crawler types into a plain text field. */
export const DEFAULT_FILL_VALUE = "test input";

/**
 * Values shaped to satisfy each `<input type>`. `fill()` writes the string
 * straight through and then checks the control kept it, so a value of the
 * wrong shape comes back as "Malformed value" — `fill("test input")` on a date
 * field throws, and the failure is then recorded against the page under test.
 *
 * The non-text values are deliberately plausible rather than nonsense: an app
 * that parses an email or a URL is worth exercising with one it will parse.
 */
const FILL_VALUE_BY_TYPE: Record<string, string> = {
  email: "test@example.com",
  tel: "+15555550123",
  url: "https://example.com",
  number: "42",
  date: "2024-01-15",
  "datetime-local": "2024-01-15T10:30",
  month: "2024-01",
  week: "2024-W03",
  time: "10:30",
  color: "#336699",
};

/**
 * Pick the value to type into one field.
 *
 * A range field is the fiddly one: its value must land on a step boundary
 * inside [min, max], so a number that is merely within the range is still
 * rejected. `min` is the one value guaranteed to satisfy both, since step
 * counting starts there — and unlike the midpoint it differs from the
 * control's default position, so filling it actually moves the slider instead
 * of writing back what was already there.
 */
export function fillValueFor(t: RawActionTarget): string {
  if (t.inputType === "range") {
    // An unset min defaults to 0, which the implicit max of 100 admits. A
    // min > max is malformed markup, and the spec clamps such a range to min,
    // so min stays the value the control will accept either way.
    // `Number("")` is 0, and finite, so the emptiness check has to come first:
    // `min=""` is an invalid bound the spec ignores, not a minimum of zero, and
    // filling "" would be rejected outright.
    if (t.min === null || t.min.trim() === "" || !Number.isFinite(Number(t.min))) {
      return "0";
    }
    return t.min.trim();
  }
  if (t.inputType !== null && t.inputType in FILL_VALUE_BY_TYPE) {
    return FILL_VALUE_BY_TYPE[t.inputType]!;
  }
  return DEFAULT_FILL_VALUE;
}

/**
 * Pick the option to set on one dropdown.
 *
 * The first offered value that is not the one already selected. Two
 * things that rule is deliberately not:
 *
 *  - not random, so `seed` still determines the run;
 *  - not "the first option", because on a dropdown that is already on its
 *    first value that sets what is already set. An action with no end
 *    state costs a step and reads in the report as though it did
 *    something, and a driver that keeps choosing it oscillates.
 *
 * `undefined` when there is nothing to set — a dropdown with one real
 * option, already on it.
 */
export function selectValueFor(t: RawActionTarget): string | undefined {
  for (const o of t.options) {
    if (o.value !== t.currentValue) return o.value;
  }
  return undefined;
}

/**
 * Build the Playwright selector the crawler will use to re-find an element.
 *
 * Every branch here has to actually match the element it was built from —
 * a selector that matches nothing is indistinguishable downstream from an
 * element that is merely off-screen, so the crawler skips it and reports
 * nothing. `:has-text()` is therefore reserved for elements that have text;
 * form fields are addressed by attribute.
 */
function selectorFor(t: RawActionTarget): string {
  if (t.text && t.text.length > 0 && t.text.length < 50) {
    return `${t.tag}:has-text("${escapeSelector(t.text)}")`;
  }
  if (t.ariaLabel) {
    return `${t.tag}[aria-label="${escapeSelector(t.ariaLabel)}"]`;
  }
  if (t.placeholder) {
    return `${t.tag}[placeholder="${escapeSelector(t.placeholder)}"]`;
  }
  if (t.name) {
    return `${t.tag}[name="${escapeSelector(t.name)}"]`;
  }
  if (t.role) {
    return `:nth-match([role="${escapeSelector(t.role)}"], ${t.index + 1})`;
  }
  // `:nth-of-type` counts siblings of the same tag under one parent, which is
  // not what `index` means — it is the element's position among this page's
  // matches. `:nth-match` is the construct for that.
  return `:nth-match(${t.tag}, ${t.index + 1})`;
}

/** Score one scraped element. Separated out so the multipliers read as a list. */
function weightFor(
  t: RawActionTarget,
  ctx: WeightingContext,
): { weight: number; type: ActionTarget["type"] } {
  let weight = 1;
  let type: ActionTarget["type"] = "interactive";

  if (t.tag === "a") {
    type = "link";
    weight = ctx.weights.navigationLinks;
    if (t.isNavLink) weight *= 1.5; // Boost navigation links

    if (t.href) {
      try {
        const absoluteUrl = normalizeUrl(new URL(t.href, ctx.baseOrigin).toString());
        switch (ctx.familiarity(absoluteUrl)) {
          case "new":
            weight *= 3; // Strong boost for unexplored ground
            break;
          case "visited":
            weight *= 0.2; // Already covered; deprioritise
            break;
          case "queued":
            break; // Spoken for, but not yet seen — leave as is
        }
      } catch {
        // Invalid URL, keep default weight
      }
    }
  } else if (t.tag === "button" || t.role === "button") {
    type = "button";
    weight = ctx.weights.buttons;
  } else if (t.tag === "select") {
    // A field, so it is weighted like one. Not `interactive`: clicking a
    // native <select> opens its list and selects nothing, so a click is
    // an action with no end state.
    type = "select";
    weight = ctx.weights.inputs;
  } else if (t.fillable) {
    type = "input";
    weight = ctx.weights.inputs;
  } else if (t.tag === "input" || t.tag === "textarea" || t.role) {
    // Everything else with a control-ish signal: ARIA roles like menuitem and
    // tab, plus the form controls `fill()` refuses — a checkbox, a submit
    // button, a `role="textbox"` div that is not contenteditable. A thrown
    // fill is recorded as a failed action against the page under test, so
    // these stay targets the crawler clicks rather than types into.
    type = "interactive";
    weight = ctx.weights.ariaInteractive;
  }

  if (t.hasVisibleText) weight *= ctx.weights.visibleText;
  if (t.isInMainContent) weight *= 1.5; // Main content beats chrome

  return { weight, type };
}

/**
 * Turn scraped elements into weighted action targets, plus the always-available
 * low-weight scroll target.
 */
export function weighActionTargets(
  raw: RawActionTarget[],
  ctx: WeightingContext,
): ActionTarget[] {
  const targets: ActionTarget[] = raw.map((t) => {
    const { weight, type } = weightFor(t, ctx);
    return {
      selector: selectorFor(t),
      role: t.role || undefined,
      // The `name` attribute last, because it is an identifier rather
      // than a label — but a form field has no text and usually no
      // aria-label, so without it the description is `(select)` or
      // `(input)` and two fields on one page are indistinguishable. This
      // only fires where there was nothing to say.
      name: t.text || t.ariaLabel || t.name || undefined,
      weight,
      type,
      href: t.href,
      fillValue: type === "input" ? fillValueFor(t) : undefined,
      selectValue: type === "select" ? selectValueFor(t) : undefined,
      geometry: t.geometry,
    };
  });

  targets.push({ selector: "window", weight: ctx.weights.scroll, type: "scroll" });
  return targets;
}

/** What the crawler falls back to when the page can't be scraped at all. */
export function scrollOnlyTargets(): ActionTarget[] {
  return [{ selector: "window", weight: 1, type: "scroll" }];
}
