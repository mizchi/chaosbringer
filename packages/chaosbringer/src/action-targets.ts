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
  tag: string;
  text: string;
  role: string | null;
  ariaLabel: string | null;
  index: number;
  hasVisibleText: boolean;
  isNavLink: boolean;
  href?: string;
  isInMainContent: boolean;
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
  const inMainContent = (el: Element) =>
    !!el.closest("main, article, [role='main'], .content, #content");

  // Links with priority for navigation
  document.querySelectorAll("a[href]").forEach((el, i) => {
    const anchor = el as HTMLAnchorElement;
    const text = anchor.innerText?.trim() || "";
    const ariaLabel = anchor.getAttribute("aria-label");
    const role = anchor.getAttribute("role");
    // Navigation links are in nav, header, or have specific roles
    const isNavLink = !!anchor.closest("nav, header, [role='navigation']");

    if (text.length < 100 || ariaLabel) {
      results.push({
        tag: "a",
        text: text || ariaLabel || "",
        role,
        ariaLabel,
        index: i,
        hasVisibleText: text.length > 0,
        isNavLink,
        href: anchor.href,
        isInMainContent: inMainContent(anchor),
      });
    }
  });

  // Buttons
  document.querySelectorAll("button, [role='button']").forEach((el, i) => {
    const text = (el as HTMLElement).innerText?.trim() || "";
    const ariaLabel = el.getAttribute("aria-label");
    const role = el.getAttribute("role") || "button";

    if (text.length < 100 || ariaLabel) {
      results.push({
        tag: "button",
        text: text || ariaLabel || "",
        role,
        ariaLabel,
        index: i,
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

  document.querySelectorAll(ariaSelectors.join(", ")).forEach((el, i) => {
    const text = (el as HTMLElement).innerText?.trim() || "";
    const ariaLabel = el.getAttribute("aria-label");
    const role = el.getAttribute("role")!;

    results.push({
      tag: el.tagName.toLowerCase(),
      text: text || ariaLabel || "",
      role,
      ariaLabel,
      index: i,
      hasVisibleText: text.length > 0,
      isNavLink: false,
      isInMainContent: inMainContent(el),
    });
  });

  // Input fields
  document
    .querySelectorAll("input, textarea, [role='textbox'], [role='searchbox']")
    .forEach((el, i) => {
      const ariaLabel = el.getAttribute("aria-label");
      const placeholder = el.getAttribute("placeholder");
      const role = el.getAttribute("role") || "input";

      results.push({
        tag: "input",
        text: ariaLabel || placeholder || "",
        role,
        ariaLabel,
        index: i,
        hasVisibleText: false,
        isNavLink: false,
        isInMainContent: inMainContent(el),
      });
    });

  return results.slice(0, 50); // Limit to prevent too many targets
}

/** Build the Playwright selector the crawler will use to re-find an element. */
function selectorFor(t: RawActionTarget): string {
  if (t.text && t.text.length > 0 && t.text.length < 50) {
    return `${t.tag}:has-text("${escapeSelector(t.text)}")`;
  }
  if (t.ariaLabel) {
    return `${t.tag}[aria-label="${escapeSelector(t.ariaLabel)}"]`;
  }
  if (t.role) {
    return `[role="${t.role}"]:nth-of-type(${t.index + 1})`;
  }
  return `${t.tag}:nth-of-type(${t.index + 1})`;
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
  } else if (t.tag === "input" || t.role === "textbox" || t.role === "searchbox") {
    type = "input";
    weight = ctx.weights.inputs;
  } else if (t.role) {
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
