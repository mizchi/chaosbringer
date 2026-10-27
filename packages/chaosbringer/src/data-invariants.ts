/**
 * Data-safety invariant presets: did bad or hostile data, delivered by a
 * fault (`faults.status(200, { body })`), a query string, tampered storage or
 * `payloadDriver`, do damage once it reached the page? Each preset is an
 * ordinary `Invariant`, like `axe()`, and nothing turns them on by default.
 *
 * `xssMarker` and `injectedMarkup` look for a canary rather than for harm in
 * general: a payload that ran sets a marker on `window`, injected markup
 * carries a marker attribute or an event-handler attribute naming a marker, a
 * script URL names a marker. A page doesn't produce those by accident, so
 * those two stay quiet on a site that never received such a payload.
 * `prototypePollution` and `renderedGarbage` are not canary-scoped: they fail
 * on any enumerable `Object.prototype` key, or any of the garbage tokens in
 * visible text, whatever put them there. See docs/recipes/data-safety.md.
 *
 * The in-page halves run through `frame.evaluate`, so they stay
 * self-contained: no imports, no references to module scope. Everything
 * else (the token pattern, the failure message) is built in Node.
 */

import type { Frame, Page } from "playwright";
import { raceTimeout, TIMED_OUT } from "./async-util.js";
import { XSS_AUTH_MARKER } from "./drivers/auth-attack/payloads.js";
import type { Invariant } from "./types.js";

/** Options every data-safety preset takes. */
export interface DataInvariantOptions {
  /** Display name for reporting. Default: the preset's `data.*` name. */
  name?: string;
  /** Restrict to URLs matching this matcher. */
  urlPattern?: Invariant["urlPattern"];
  /** Phase to evaluate. Default: `afterActions`. */
  when?: Invariant["when"];
}

export interface XssMarkerOptions extends DataInvariantOptions {
  /**
   * `window` properties a payload sets when it runs. Default:
   * `__cb_xss_fired` (`XSS_AUTH_MARKER`) and `__xss_fired` (the
   * `payloadDriver` `xss` set).
   */
  markers?: readonly string[];
}

export interface InjectedMarkupOptions extends DataInvariantOptions {
  /** What a `javascript:` URL must contain to count. Default: as `xssMarker`. */
  markers?: readonly string[];
  /** Attribute a payload puts on the markup it injects. Default: `data-cb-injected`. */
  attribute?: string;
  /**
   * Count every `javascript:` URL, marker or not. Off by default:
   * `javascript:void(0)` is a common placeholder href.
   */
  anyJavascriptUrl?: boolean;
}

export type PrototypePollutionOptions = DataInvariantOptions;

export interface RenderedGarbageOptions extends DataInvariantOptions {
  /**
   * Text that means a value was rendered without being checked. Default:
   * `undefined`, `NaN`, `[object Object]`, `Invalid Date`. `null` is left
   * out: it is an ordinary word in prose.
   */
  tokens?: readonly string[];
  /**
   * Elements whose text isn't checked: code samples, editors and the like,
   * where the tokens are content. Default:
   * `code,pre,kbd,samp,script,style,textarea,noscript,[contenteditable]`.
   * `""` checks everything. Prose and API-reference text are not scoped out
   * by default — a page that writes about `undefined` or `NaN` needs its own
   * `ignore`, `selector` or `urlPattern`.
   */
  ignore?: string;
  /** Elements whose text is checked. Default: `body`. */
  selector?: string;
}

export interface NotBlankOptions extends DataInvariantOptions {
  /** Elements whose text counts. Default: `body`. */
  selector?: string;
  /** Fewest characters of visible text, all frames together. Default: 1. */
  minText?: number;
  /** Text that marks an error screen; a string matches as a substring. Default: none. */
  errorText?: ReadonlyArray<string | RegExp>;
}

export interface DataSafetyOptions {
  /** Phase for every preset. Default: `afterActions`. */
  when?: Invariant["when"];
  /** Restrict every preset to URLs matching this matcher. */
  urlPattern?: Invariant["urlPattern"];
  /** Canary markers for `xssMarker` and `injectedMarkup`. */
  markers?: readonly string[];
  /** Per-preset options, over the shared ones above. */
  xssMarker?: XssMarkerOptions;
  injectedMarkup?: InjectedMarkupOptions;
  prototypePollution?: PrototypePollutionOptions;
  renderedGarbage?: RenderedGarbageOptions;
}

/** `__xss_fired` is what the `xss` payload set (drivers/payloads.ts) writes. */
const DEFAULT_MARKERS: readonly string[] = [XSS_AUTH_MARKER, "__xss_fired"];
const DEFAULT_GARBAGE_TOKENS: readonly string[] = ["undefined", "NaN", "[object Object]", "Invalid Date"];
const DEFAULT_GARBAGE_IGNORE = "code,pre,kbd,samp,script,style,textarea,noscript,[contenteditable]";

/** Most samples a failure message lists per frame, and the longest each is. */
const MAX_SAMPLES = 3;
const MAX_SAMPLE_LENGTH = 120;

/**
 * How long one iframe gets to answer a probe. Past it the frame is skipped:
 * an out-of-process iframe whose main thread is stuck never answers, and
 * would hold the invariant, and the crawl, forever.
 */
const FRAME_PROBE_TIMEOUT_MS = 5_000;

/** What a probe found in one frame: how many, and the first few. */
interface Hits {
  count: number;
  samples: string[];
}

/** One frame's `Hits`. `frame` is its URL, or `undefined` for the top document. */
export interface FrameHits extends Hits {
  frame?: string;
}

/**
 * `run` on the top document, then on every iframe. The top document's
 * failure fails the check, as it does in `axe()`. An iframe that can't be
 * read (detached or navigated away mid-check, or stuck past
 * `FRAME_PROBE_TIMEOUT_MS`) is skipped, and so is any frame showing the
 * browser's error page for a navigation the crawl blocked: that page isn't
 * the site's.
 */
async function inEveryFrame<R>(
  page: Page,
  run: (frame: Frame) => Promise<R>
): Promise<Array<{ frame: string | undefined; result: R }>> {
  const main = page.mainFrame();
  const out: Array<{ frame: string | undefined; result: R }> = [];
  if (!main.url().startsWith("chrome-error:")) out.push({ frame: undefined, result: await run(main) });
  for (const frame of page.frames()) {
    if (frame === main || frame.url().startsWith("chrome-error:")) continue;
    const evaluation = run(frame);
    // Once timed out, a later rejection (the page closing) is nobody's to handle.
    evaluation.catch(() => {});
    try {
      const result = await raceTimeout(evaluation, FRAME_PROBE_TIMEOUT_MS);
      // An iframe's url() is "" before its first commit (e.g. the one a
      // `javascript:` payload leaves); name it so the message doesn't read
      // "in frame :".
      if (result !== TIMED_OUT) out.push({ frame: frame.url() || "about:blank", result });
    } catch (err) {
      // A frame detached or navigated away mid-check has nothing left to look
      // at and is skipped. A SyntaxError is a mistake in a probe option (an
      // invalid `ignore` or `selector`), not a vanished frame, so it is not
      // swallowed: it must fail the check in every frame, as it does in the
      // top document.
      const message = err instanceof Error ? err.message : String(err);
      if (/SyntaxError|is not a valid selector/.test(message)) throw err;
    }
  }
  return out;
}

/** `inEveryFrame` for a probe that counts hits, as `formatFrameHits` takes them. */
async function hitsInEveryFrame(page: Page, run: (frame: Frame) => Promise<Hits>): Promise<FrameHits[]> {
  return (await inEveryFrame(page, run)).map(({ frame, result }) => ({ frame, ...result }));
}

/** Collapse whitespace and cut `s` to `max` characters. */
function clip(s: string, max = MAX_SAMPLE_LENGTH): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The failure message for what the probes found, or `true` when they found
 * nothing. Frames are listed as `axe()` lists them, the top document first:
 *   `XSS marker set: window.__cb_xss_fired; in frame http://x/embed: window.__xss_fired`
 * Each frame lists at most `MAX_SAMPLES` samples and counts the rest.
 */
export function formatFrameHits(what: string, hits: readonly FrameHits[]): string | true {
  const sections: string[] = [];
  for (const h of hits) {
    if (h.count === 0) continue;
    const shown = h.samples.slice(0, MAX_SAMPLES).map((s) => clip(s));
    const more = h.count - shown.length;
    const list = `${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`.trim();
    sections.push(h.frame === undefined ? list : `in frame ${h.frame}: ${list}`);
  }
  return sections.length === 0 ? true : `${what}: ${sections.join("; ")}`;
}

function base(defaultName: string, options: DataInvariantOptions): Omit<Invariant, "check"> {
  return {
    name: options.name ?? defaultName,
    urlPattern: options.urlPattern,
    when: options.when ?? "afterActions",
  };
}

/** In-page: the markers set (truthy) as own properties of this frame's `window`. */
function markersSet(markers: readonly string[]): Hits {
  // Named element access (`<b id="__xss_fired">`) and other DOM clobbering
  // reach `window` through the WindowProperties prototype, not as own
  // properties, so an own check tells a script that ran from a marker that is
  // merely named in markup.
  const set = markers.filter(
    (m) => Object.prototype.hasOwnProperty.call(window, m) && Boolean((window as unknown as Record<string, unknown>)[m])
  );
  return { count: set.length, samples: set.map((m) => `window.${m}`) };
}

/**
 * Fails when a payload ran: any of `markers` is truthy on `window` in the
 * top document or an iframe.
 */
export function xssMarker(options: XssMarkerOptions = {}): Invariant {
  const markers = [...(options.markers ?? DEFAULT_MARKERS)];
  return {
    ...base("data.xss-marker", options),
    async check({ page }) {
      return formatFrameHits("XSS marker set", await hitsInEveryFrame(page, (f) => f.evaluate(markersSet, markers)));
    },
  };
}

/**
 * In-page: elements carrying `attribute`, and URL attributes holding a
 * `javascript:` URL that names a marker (any, with `anyJavascriptUrl`).
 */
function injectedElements(arg: {
  attribute: string;
  markers: readonly string[];
  anyJavascriptUrl: boolean;
  max: number;
}): Hits {
  const samples: string[] = [];
  let count = 0;
  const hit = (sample: string) => {
    count++;
    if (samples.length < arg.max) samples.push(sample);
  };
  for (const el of Array.from(document.querySelectorAll(`[${CSS.escape(arg.attribute)}]`))) {
    const value = el.getAttribute(arg.attribute);
    hit(`<${el.localName} ${arg.attribute}${value ? `="${value}"` : ""}>`);
  }
  // `*|href` also matches SVG's `xlink:href`.
  for (const el of Array.from(document.querySelectorAll("[href],[src],[action],[formaction],[*|href]"))) {
    for (const attr of Array.from(el.attributes)) {
      if (!["href", "src", "action", "formaction", "xlink:href"].includes(attr.name.toLowerCase())) continue;
      // The URL parser drops leading controls and spaces, and tabs and
      // newlines anywhere, so ` java\tscript:` is a `javascript:` URL too.
      // Dropping all of them everywhere errs towards flagging.
      const url = attr.value.replace(/[\x00-\x20\x7f]/g, ""); // oxlint-disable-line no-control-regex
      if (!/^javascript:/i.test(url)) continue;
      let decoded = url;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        // Not percent-encoded consistently; match the raw value only.
      }
      if (arg.anyJavascriptUrl || arg.markers.some((m) => url.includes(m) || decoded.includes(m))) {
        hit(`<${el.localName} ${attr.name}="${attr.value}">`);
      }
    }
  }
  // An event-handler attribute (`onerror`, `onmouseover`, …) that names a
  // marker is as clear a canary as a `javascript:` URL: the payload reached
  // the DOM as an attribute, whether or not the handler has fired. The
  // crawler never hovers, so this flags the sink, not its execution.
  for (const el of Array.from(document.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.length > 2 && name.startsWith("on") && arg.markers.some((m) => attr.value.includes(m))) {
        hit(`<${el.localName} ${attr.name}="${attr.value}">`);
      }
    }
  }
  return { count, samples };
}

/**
 * Fails when a payload reached the DOM as markup or as a script URL: an
 * element carries `attribute` (default `data-cb-injected`), an `href` / `src`
 * / `action` / `formaction` / `xlink:href` holds a `javascript:` URL naming a
 * marker, or an `on*` event-handler attribute names a marker. The crawler
 * never clicks a `javascript:` link or hovers, so this flags the sink, not
 * its execution.
 */
export function injectedMarkup(options: InjectedMarkupOptions = {}): Invariant {
  const attribute = options.attribute ?? "data-cb-injected";
  if (attribute === "") {
    throw new Error('chaosbringer: injectedMarkup "attribute" must not be empty');
  }
  const arg = {
    attribute,
    markers: [...(options.markers ?? DEFAULT_MARKERS)],
    anyJavascriptUrl: options.anyJavascriptUrl ?? false,
    max: MAX_SAMPLES,
  };
  return {
    ...base("data.injected-markup", options),
    async check({ page }) {
      return formatFrameHits("injected markup", await hitsInEveryFrame(page, (f) => f.evaluate(injectedElements, arg)));
    },
  };
}

/** In-page: enumerable keys on this frame's `Object.prototype`. */
function prototypeKeys(): Hits {
  const keys = Object.keys(Object.prototype);
  return { count: keys.length, samples: keys };
}

/**
 * Fails when `Object.prototype` has an enumerable key in any frame: what an
 * unguarded deep merge or query parser leaves behind after a `__proto__`
 * key. A polyfill's `defineProperty` is not enumerable and stays clean.
 */
export function prototypePollution(options: PrototypePollutionOptions = {}): Invariant {
  return {
    ...base("data.prototype-pollution", options),
    async check({ page }) {
      return formatFrameHits("Object.prototype polluted", await hitsInEveryFrame(page, (f) => f.evaluate(prototypeKeys)));
    },
  };
}

/**
 * The regex source that finds any of `tokens` in visible text. A token is
 * bounded by a word character only on the side it begins or ends with one, so
 * `undefinedBehavior` and `isNaN` don't match, but `$NaN` (a price) and
 * `Hello[object Object]` do: visible text is prose, not source, where `$`
 * reads as a currency symbol and brackets are punctuation, not word edges.
 */
export function garbagePattern(tokens: readonly string[]): string {
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = /\w/;
  const parts = tokens.map((t) => {
    const pre = t.length > 0 && word.test(t[0]!) ? "(?<!\\w)" : "";
    const post = t.length > 0 && word.test(t.at(-1)!) ? "(?!\\w)" : "";
    return `${pre}${escape(t)}${post}`;
  });
  return `(?:${parts.join("|")})`;
}

/** In-page: visible text nodes under `selector` that contain a token. */
function garbageText(arg: { source: string; ignore: string; selector: string; max: number }): Hits {
  const re = new RegExp(arg.source);
  const samples: string[] = [];
  let count = 0;
  // Run the ignore selector once up front, so a mistake in it throws on every
  // page rather than only on the ones where a token happened to match.
  if (arg.ignore) document.querySelector(arg.ignore);
  // `checkVisibility` reports an `<option>` and a `display: contents` element
  // as not rendered, though the option the select shows and the contents
  // element's text are on screen. Judge an option by its `<select>`, and a
  // `display: contents` node by the nearest ancestor that has a box.
  const shown = (el: Element): boolean => {
    const option = el.closest("option,optgroup");
    if (option) {
      const select = option.closest("select");
      return !select || select.checkVisibility?.({ visibilityProperty: true }) !== false;
    }
    let box: Element | null = el;
    while (box && getComputedStyle(box).display === "contents") box = box.parentElement;
    return !box || box.checkVisibility?.({ visibilityProperty: true }) !== false;
  };
  const roots = Array.from(document.querySelectorAll(arg.selector));
  for (const root of roots) {
    // A root nested in another matched root is walked with the outer one.
    // Climbing from the parent is O(depth); scanning every other root for one
    // that contains this one is O(roots²) — minutes on a big table.
    if (root.parentElement?.closest(arg.selector)) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const own = node.nodeValue ?? "";
      const match = re.exec(own);
      const parent = node.parentElement;
      if (!match || !parent) continue;
      if (arg.ignore && parent.closest(arg.ignore)) continue;
      if (!shown(parent)) continue;
      count++;
      if (samples.length >= arg.max) continue;
      // A bare token (`Total: <span>{price}</span>`) reads better with the
      // text around it: take the nearest ancestor below the root that has
      // some, and find the token in it by its offset.
      let context: Node = node;
      for (let el: Element | null = parent; el && el !== root && context.textContent?.trim() === match[0]; el = el.parentElement) {
        context = el;
      }
      const text = context.textContent ?? "";
      const range = document.createRange();
      range.setStart(context, 0);
      range.setEnd(node, match.index);
      const at = range.toString().length;
      const from = Math.max(0, at - 40);
      const to = at + match[0].length + 40;
      const around = text.slice(from, to).replace(/\s+/g, " ").trim();
      samples.push(`${match[0]} in "${from > 0 ? "…" : ""}${around}${to < text.length ? "…" : ""}"`);
    }
  }
  return { count, samples };
}

/**
 * Fails when visible text shows a value rendered without a check:
 * `undefined`, `NaN`, `[object Object]` or `Invalid Date` as a word. Text in
 * code samples, form fields, hidden elements and `visibility: hidden` ones is
 * skipped.
 */
export function renderedGarbage(options: RenderedGarbageOptions = {}): Invariant {
  // An empty token would match every text node.
  const tokens = (options.tokens ?? DEFAULT_GARBAGE_TOKENS).filter((t) => t !== "");
  const arg = {
    source: garbagePattern(tokens),
    ignore: options.ignore ?? DEFAULT_GARBAGE_IGNORE,
    selector: options.selector ?? "body",
    max: MAX_SAMPLES,
  };
  return {
    ...base("data.rendered-garbage", options),
    async check({ page }) {
      if (tokens.length === 0) return true;
      return formatFrameHits("rendered garbage", await hitsInEveryFrame(page, (f) => f.evaluate(garbageText, arg)));
    },
  };
}

/**
 * In-page: the visible text of the elements matching `selector`, including
 * text inside open shadow roots. A web-component page (Lit, Stencil, Shoelace)
 * renders into shadow DOM, which `innerText` does not descend into, so without
 * this a fully rendered page would read as 0 characters. A closed shadow root
 * can't be read and is missed.
 */
function visibleText(selector: string): string {
  const parts: string[] = [];
  const push = (el: Element) => {
    const text = (el instanceof HTMLElement ? el.innerText : (el.textContent ?? "")).trim();
    if (text) parts.push(text);
  };
  const descendShadows = (root: Element | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.shadowRoot) {
        for (const child of Array.from(el.shadowRoot.children)) push(child);
        descendShadows(el.shadowRoot);
      }
    }
  };
  for (const el of Array.from(document.querySelectorAll(selector))) {
    push(el);
    descendShadows(el);
  }
  return parts.join("\n");
}

/** The first match of `pattern` in `text`, ignoring the regex's `lastIndex`. */
function firstMatch(text: string, pattern: string | RegExp): string | undefined {
  if (typeof pattern === "string") return pattern !== "" && text.includes(pattern) ? pattern : undefined;
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).exec(text)?.[0];
}

/**
 * Fails when the page shows fewer than `minText` characters of visible text,
 * all frames together (the blank screen a swallowed error leaves), or when
 * any frame shows one of `errorText`. Not part of `dataSafety()`: a canvas
 * or image-only page is blank by design.
 */
export function notBlank(options: NotBlankOptions = {}): Invariant {
  const selector = options.selector ?? "body";
  const minText = options.minText ?? 1;
  const errorText = options.errorText ?? [];
  return {
    ...base("data.not-blank", options),
    async check({ page }) {
      const texts = await inEveryFrame(page, (f) => f.evaluate(visibleText, selector));
      // Every frame was gone or blocked: nothing to judge.
      if (texts.length === 0) return true;
      const length = texts.reduce((n, { result }) => n + result.length, 0);
      if (length < minText) {
        return `blank page: ${length} characters of visible text in ${selector}, fewer than ${minText}`;
      }
      const shown = texts.map(({ frame, result }) => {
        const matches = errorText.map((p) => firstMatch(result, p)).filter((m) => m !== undefined);
        return { frame, count: matches.length, samples: matches.map((m) => JSON.stringify(m)) };
      });
      return formatFrameHits("error text shown", shown);
    },
  };
}

/**
 * The security and rendering presets, in this order: `xssMarker`,
 * `injectedMarkup`, `prototypePollution`, `renderedGarbage`. `notBlank` is
 * left out (see there); add it when every page you crawl shows text.
 */
export function dataSafety(options: DataSafetyOptions = {}): Invariant[] {
  const shared = { when: options.when, urlPattern: options.urlPattern };
  const markers = options.markers;
  return [
    xssMarker({ ...shared, markers, ...options.xssMarker }),
    injectedMarkup({ ...shared, markers, ...options.injectedMarkup }),
    prototypePollution({ ...shared, ...options.prototypePollution }),
    renderedGarbage({ ...shared, ...options.renderedGarbage }),
  ];
}
