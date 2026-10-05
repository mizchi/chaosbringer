/**
 * The crawler's action targets, checked against the accessibility snapshot.
 *
 * The crawl finds what to act on by CSS (`collectRawTargets`): links,
 * buttons, eight ARIA roles, form fields, dropdowns. The snapshot
 * (`aria-snapshot.ts`) sees what a user can operate, by computed role and
 * by `cursor: pointer`. Joining the two gives the crawl:
 *
 * - **targets the scrape misses**: a `<div onclick>` with a pointer cursor,
 *   a `<summary>`, a control past the scrape's cap. They are scraped here,
 *   one element at a time, into the same `RawActionTarget` shape, so they
 *   are weighed and acted on like any other target;
 * - **a description of each target from the tree**: its accessible name,
 *   state, and where it sits (`button "Pay" — in dialog "Checkout"`), for
 *   drivers and models to read;
 * - **an outline of the page** whose `[#N]` tags are the driver's candidate
 *   indices.
 *
 * Elements are joined by their peer key, the same `tag:<tag>:<n>` /
 * `role:<role>:<n>` count `collectRawTargets` numbers its targets by.
 */

import type { ElementHandle, Page } from "playwright";
import type { RawActionTarget } from "./action-targets.js";
import type { AriaCandidate, AriaView } from "./aria-snapshot.js";
import type { ActionTarget } from "./types.js";

/** How `collectRawTargets` numbers a target: by role attribute when it has one, else by tag. */
export function peerKey(t: Pick<RawActionTarget, "tag" | "role" | "index">): string {
  return t.role === null ? `tag:${t.tag}:${t.index}` : `role:${t.role}:${t.index}`;
}

export interface AriaTargetMatch {
  candidate: AriaCandidate;
  /** The element's peer key, `null` when its ref no longer resolves. */
  key: string | null;
  /** The element scraped as a target, for joining to targets the CSS scrape lacks. */
  raw: RawActionTarget | null;
}

/**
 * Resolve each snapshot candidate to its element, and scrape it.
 *
 * One round trip per candidate to turn its ref into a handle, then one
 * evaluate for all of them. A ref that does not resolve (the page re-rendered
 * since the snapshot) gives `key: null`.
 */
export async function matchAriaTargets(page: Page, view: AriaView): Promise<AriaTargetMatch[]> {
  const handles: (ElementHandle | null)[] = [];
  for (const c of view.candidates) {
    handles.push(await page.locator(`aria-ref=${c.ref}`).elementHandle({ timeout: 250 }).catch(() => null));
  }
  type Scraped = ({ key: string; raw: RawActionTarget } | null)[];
  // Typed by hand: inferring `evaluate`'s serialisable-argument type through
  // an array of handles is too deep for tsc.
  const evaluate = page.evaluate.bind(page) as unknown as (fn: (els: (Element | null)[]) => Scraped, arg: unknown) => Promise<Scraped>;
  const scraped = await evaluate(scrapeElements, handles).catch(() => null);
  for (const h of handles) void h?.dispose().catch(() => {});
  return view.candidates.map((candidate, i) => {
    const s = scraped?.[i] ?? null;
    return { candidate, key: s?.key ?? null, raw: s?.raw ?? null };
  });
}

/**
 * Runs in the page. For each element: its peer key, and the element as a
 * `RawActionTarget`. Self-contained, like `collectRawTargets`.
 */
function scrapeElements(els: (Element | null)[]): ({ key: string; raw: RawActionTarget } | null)[] {
  const peers = new Map<string, Element[]>();
  const peerList = (role: string | null, tag: string): Element[] => {
    const k = role === null ? `tag:${tag}` : `role:${role}`;
    let list = peers.get(k);
    if (!list) {
      list =
        role === null
          ? (Array.prototype.slice.call(document.querySelectorAll(tag)) as Element[])
          : (Array.prototype.filter.call(document.querySelectorAll("[role]"), (e: Element) => e.getAttribute("role") === role) as Element[]);
      peers.set(k, list);
    }
    return list;
  };
  return els.map((el) => {
    if (!el || !(el instanceof HTMLElement || el instanceof SVGElement)) return null;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const index = peerList(role, tag).indexOf(el);
    if (index < 0) return null;
    const html = el as HTMLElement;
    const text = (html.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
    const inputType = tag === "input" ? (el as HTMLInputElement).type : null;
    const unfillable = ["checkbox", "radio", "submit", "button", "reset", "image", "file", "hidden"];
    const readOnly = (el as HTMLInputElement).readOnly === true;
    const fillable =
      !readOnly && (tag === "textarea" || html.isContentEditable === true || (inputType !== null && unfillable.indexOf(inputType) === -1));
    const r = el.getBoundingClientRect();
    const x0 = Math.max(r.left, 0);
    const y0 = Math.max(r.top, 0);
    const x1 = Math.min(r.right, window.innerWidth);
    const y1 = Math.min(r.bottom, window.innerHeight);
    const raw: RawActionTarget = {
      tag,
      text: fillable ? "" : text,
      role,
      ariaLabel: el.getAttribute("aria-label"),
      placeholder: el.getAttribute("placeholder"),
      name: el.getAttribute("name"),
      index,
      hasVisibleText: !fillable && text.length > 0,
      isNavLink: !!el.closest("nav, header, [role='navigation']"),
      ...(tag === "a" && (el as HTMLAnchorElement).href ? { href: (el as HTMLAnchorElement).href } : {}),
      isInMainContent: !!el.closest("main, article, [role='main'], .content, #content"),
      fillable,
      inputType,
      min: el.getAttribute("min"),
      max: el.getAttribute("max"),
      options: [],
      currentValue: typeof (el as HTMLInputElement).value === "string" ? (el as HTMLInputElement).value : null,
      geometry: {
        bbox: { x: r.left, y: r.top, width: r.width, height: r.height },
        inViewport: x1 > x0 && y1 > y0,
        inert: window.getComputedStyle(el).pointerEvents === "none",
      },
    };
    return { key: role === null ? `tag:${tag}:${index}` : `role:${role}:${index}`, raw };
  });
}

/** Targets the snapshot adds, at most. */
export const ARIA_EXTRA_CAP = 20;

/**
 * Join `matches` to the CSS scrape's `targets` (in place): each target the
 * snapshot also saw gets its tree description and ref. Returns the snapshot
 * candidates the scrape did not find, as raw targets with the selector they
 * should be acted on by — the candidate's role selector when it has one.
 * A select's options and anything already a target are left out.
 */
export function joinAriaTargets(
  targets: ActionTarget[],
  matches: readonly AriaTargetMatch[],
): { raw: RawActionTarget; selector?: string; candidate: AriaCandidate }[] {
  const byKey = new Map<string, ActionTarget>();
  for (const t of targets) if (t.peerKey) byKey.set(t.peerKey, t);
  const extras: { raw: RawActionTarget; selector?: string; candidate: AriaCandidate }[] = [];
  for (const m of matches) {
    if (m.key === null || m.raw === null) continue;
    const known = byKey.get(m.key);
    if (known) {
      known.ariaDescription = m.candidate.description;
      known.ariaRef = m.candidate.ref;
      continue;
    }
    if (m.candidate.type === "select") continue; // the scrape reaches every <select>
    if (extras.length >= ARIA_EXTRA_CAP) continue;
    extras.push({ raw: m.raw, candidate: m.candidate, ...(m.candidate.selector ? { selector: m.candidate.selector } : {}) });
  }
  return extras;
}
