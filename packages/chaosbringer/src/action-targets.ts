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

import type { ActionTarget, ActionWeights } from "./types.js";
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
   * Whether Playwright's `fill()` will accept this element with an arbitrary
   * string. True only for text-ish `<input>`, `<textarea>` and contenteditable
   * elements — a checkbox, a submit button or a `role="textbox"` div that is
   * not contenteditable all throw. They are still worth acting on, just by
   * clicking rather than typing, so the scrape records the fact and leaves the
   * decision to `weighActionTargets`.
   */
  fillable: boolean;
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
  /** Record one scraped element; `index` is filled in once all are collected. */
  const push = (el: Element, t: Omit<RawActionTarget, "index">) => {
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
      hasVisibleText: text.length > 0,
      isNavLink: false,
      isInMainContent: inMainContent(el),
    });
  });

  // Form fields. Note `text` stays empty even when the field has a label: a
  // selector built from an input's label with `:has-text()` matches nothing,
  // because an <input> has no text content to match against.
  const FILLABLE_INPUT_TYPES = [
    "text",
    "search",
    "email",
    "password",
    "tel",
    "url",
  ];
  document
    .querySelectorAll(
      "input, textarea, [contenteditable], [role='textbox'], [role='searchbox']"
    )
    .forEach((el) => {
      const tag = el.tagName.toLowerCase();
      // `.type` normalises a missing or unrecognised type attribute to "text".
      const inputType = tag === "input" ? (el as HTMLInputElement).type : "";
      const fillable =
        tag === "textarea" ||
        (el as HTMLElement).isContentEditable ||
        (tag === "input" && FILLABLE_INPUT_TYPES.indexOf(inputType) !== -1);

      push(el, {
        tag,
        text: "",
        role: el.getAttribute("role"),
        ariaLabel: el.getAttribute("aria-label"),
        placeholder: el.getAttribute("placeholder"),
        name: el.getAttribute("name"),
        fillable,
        hasVisibleText: false,
        isNavLink: false,
        isInMainContent: inMainContent(el),
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

  return results.slice(0, 50); // Limit to prevent too many targets
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
      name: t.text || t.ariaLabel || undefined,
      weight,
      type,
      href: t.href,
    };
  });

  targets.push({ selector: "window", weight: ctx.weights.scroll, type: "scroll" });
  return targets;
}

/** What the crawler falls back to when the page can't be scraped at all. */
export function scrollOnlyTargets(): ActionTarget[] {
  return [{ selector: "window", weight: 1, type: "scroll" }];
}
