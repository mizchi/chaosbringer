/**
 * Built-in invariant presets. Mirrors the `faults` helpers — lets users wire
 * common assertions without writing the check() closure each time.
 *
 * Presets declared here are otherwise ordinary Invariants. They just know how
 * to set up their own tooling (e.g. inject axe-core into the page).
 */

import type { Frame } from "playwright";
import { raceTimeout, TIMED_OUT } from "./async-util.js";
import type { Invariant } from "./types.js";
import { visualRegression } from "./visual.js";
import { stateMachineInvariant } from "./state-machine-invariants.js";
import { dataSafety, injectedMarkup, notBlank, prototypePollution, renderedGarbage, xssMarker } from "./data-invariants.js";

export interface AxeInvariantOptions {
  /** Display name for reporting. Default: `a11y-axe`. */
  name?: string;
  /** Restrict to URLs matching this matcher. */
  urlPattern?: Invariant["urlPattern"];
  /** Phase to evaluate. Default: `afterActions`. */
  when?: Invariant["when"];
  /**
   * Axe rule tags to include. Default: WCAG 2 A / AA. Pass fewer for stricter
   * runs (`["wcag2a"]`) or more for exhaustive audits (add `"best-practice"`).
   */
  tags?: string[];
  /** CSS selectors to restrict the scan to. */
  include?: string[];
  /** CSS selectors to skip (e.g. 3rd-party widgets you don't own). */
  exclude?: string[];
  /** Rule ids to disable, e.g. `["color-contrast"]`. */
  disableRules?: string[];
}

const DEFAULT_AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** Shape of the axe-core run result we rely on. Kept minimal. */
interface AxeViolationNode {
  html?: string;
  target?: unknown;
  /** Selector path from the top document, one entry per frame then the node's own. */
  ancestry?: unknown;
}
interface AxeViolation {
  id: string;
  impact?: string | null;
  help?: string;
  nodes: AxeViolationNode[];
}
interface AxeResults {
  violations: AxeViolation[];
}

/** Shape of what axe.run receives. Pure — returned verbatim into page.evaluate. */
export interface AxeRunPayload {
  context: { include?: string[][]; exclude?: string[][] } | null;
  options: {
    runOnly: { type: "tag"; values: string[] };
    rules?: Record<string, { enabled: false }>;
    resultTypes: ["violations"];
  };
}

export function buildAxeRunPayload(opts: AxeInvariantOptions = {}): AxeRunPayload {
  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : DEFAULT_AXE_TAGS;
  const contextEntries: { include?: string[][]; exclude?: string[][] } = {};
  if (opts.include && opts.include.length > 0) {
    contextEntries.include = opts.include.map((s) => [s]);
  }
  if (opts.exclude && opts.exclude.length > 0) {
    contextEntries.exclude = opts.exclude.map((s) => [s]);
  }
  const hasContext = contextEntries.include || contextEntries.exclude;
  const rules: Record<string, { enabled: false }> | undefined = opts.disableRules?.length
    ? Object.fromEntries(opts.disableRules.map((r) => [r, { enabled: false as const }]))
    : undefined;
  return {
    context: hasContext ? contextEntries : null,
    options: {
      runOnly: { type: "tag", values: tags },
      ...(rules ? { rules } : {}),
      resultTypes: ["violations"],
    },
  };
}

/**
 * Render a violations array to a single-line summary suitable for the
 * invariant failure message. Example:
 *   `3 a11y violations: color-contrast(×5, serious), image-alt(×2, critical)`
 *
 * `frameOf` names the iframe a node is in (the preset passes its URL), or
 * returns `undefined` for the top document. A rule's nodes in an iframe are
 * counted, and listed after the top document's, as a violation of that frame:
 *   `3 a11y violations: image-alt(×1, critical); in frame http://x/embed: button-name(×1, critical), image-alt(×1, critical)`
 */
export function formatAxeViolations(
  violations: AxeViolation[],
  frameOf: (node: AxeViolationNode) => string | undefined = () => undefined
): string {
  if (violations.length === 0) return "";
  const part = (v: AxeViolation, count: number) => `${v.id}(×${count}${v.impact ? `, ${v.impact}` : ""})`;
  const top: string[] = [];
  const frames = new Map<string, string[]>();
  for (const v of violations) {
    let inTop = 0;
    const inFrames = new Map<string, number>();
    for (const node of v.nodes ?? []) {
      const frame = frameOf(node);
      if (frame === undefined) inTop++;
      else inFrames.set(frame, (inFrames.get(frame) ?? 0) + 1);
    }
    if (inTop > 0 || inFrames.size === 0) top.push(part(v, inTop));
    for (const [frame, count] of inFrames) {
      const parts = frames.get(frame) ?? [];
      parts.push(part(v, count));
      frames.set(frame, parts);
    }
  }
  let count = top.length;
  const sections = top.length > 0 ? [top.join(", ")] : [];
  for (const [frame, parts] of frames) {
    count += parts.length;
    sections.push(`in frame ${frame}: ${parts.join(", ")}`);
  }
  return `${count} a11y violations: ${sections.join("; ")}`;
}

async function loadAxeSource(): Promise<string> {
  try {
    const mod = (await import("axe-core")) as unknown as { default?: { source?: string }; source?: string };
    const source = mod.default?.source ?? mod.source;
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("axe-core did not expose a `source` string — check the installed version.");
    }
    return source;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("axe-core")) throw err;
    throw new Error(
      "chaosbringer: invariants.axe() requires the `axe-core` package. Install it with `pnpm add axe-core`."
    );
  }
}

/** The part of the page's `axe` global the preset calls. */
interface AxeGlobal {
  run(context: unknown, options: unknown): Promise<AxeResults>;
  /** Missing before axe-core 4.3. */
  runPartial(context: unknown, options: unknown): Promise<unknown>;
  finishRun(partials: unknown[], options: unknown): Promise<AxeResults>;
  utils: {
    getFrameContexts(context: unknown, options: unknown): Array<{ frameSelector: unknown; frameContext: unknown }>;
    shadowSelect(selector: unknown): Element | null;
  };
}
type AxeWindow = typeof globalThis & { axe: AxeGlobal };

/** Key for the chain of `getFrameContexts` selectors that leads to a frame from the top document. */
const frameKey = (chain: unknown[]) => JSON.stringify(chain);

/**
 * How long one iframe gets to take axe in and run `axe.runPartial`. Past it
 * the frame is left untested: its renderer may be stuck (a cross-origin
 * widget spinning in its own process), or its timers may never fire (a
 * `sandbox` CSP header without `allow-scripts`, which the iframe element
 * doesn't show), and either would hold the invariant forever.
 */
const FRAME_SCAN_TIMEOUT_MS = 10_000;

/** One frame's `axe.runPartial` result, and the iframes axe picks out of it. */
interface FrameScan {
  partial: unknown;
  frameContexts: Array<{ frameSelector: unknown; frameContext: unknown }>;
}

async function scanFrame(frame: Frame, context: unknown, options: AxeRunPayload["options"]): Promise<FrameScan> {
  const frameContexts = await frame.evaluate(
    (p) => (globalThis as AxeWindow).axe.utils.getFrameContexts(p.context ?? document, p.options),
    { context, options }
  );
  const partial = await frame.evaluate(
    (p) => (globalThis as AxeWindow).axe.runPartial(p.context ?? document, p.options),
    { context, options }
  );
  return { partial, frameContexts };
}

/**
 * The iframe `frameSelector` picks out of `parent`, with axe taken in and
 * scanned, or `null` for one that can't be: gone, the browser's error page
 * left by a navigation the crawl blocked, or sandboxed without
 * `allow-scripts`. axe can't finish where no timer fires, and every timer it
 * sets there logs "Blocked script execution" to the console, which the crawl
 * records as page errors.
 */
async function scanChildFrame(
  parent: Frame,
  frameSelector: unknown,
  frameContext: unknown,
  source: string,
  options: AxeRunPayload["options"]
): Promise<{ frame: Frame; scan: FrameScan } | null> {
  const element = (
    await parent.evaluateHandle((s) => (globalThis as AxeWindow).axe.utils.shadowSelect(s), frameSelector)
  ).asElement();
  if (!element) return null;
  const runsScripts = await element.evaluate(
    (el) => !(el instanceof HTMLIFrameElement && el.hasAttribute("sandbox") && !el.sandbox.contains("allow-scripts"))
  );
  const frame = runsScripts ? await element.contentFrame() : null;
  await element.dispose();
  if (!frame || frame.url().startsWith("chrome-error:")) return null;
  await frame.evaluate(source);
  return { frame, scan: await scanFrame(frame, frameContext, options) };
}

/**
 * `scan` of `frame`, then depth-first `axe.runPartial` in every iframe axe
 * picks out of it: the order `axe.finishRun` pairs results with frames in.
 * Each frame is scanned through its own Playwright `Frame`, so cross-origin
 * and out-of-process iframes are covered without axe's postMessage between
 * frames. A frame that can't be scanned (see `scanChildFrame`, detached
 * mid-scan, or over `FRAME_SCAN_TIMEOUT_MS`) contributes `null`, which axe
 * counts as untested rather than as a violation. `frameUrls` gets each
 * scanned iframe's URL under its `frameKey`.
 */
async function runPartialInFrames(
  frame: Frame,
  scan: FrameScan,
  source: string,
  options: AxeRunPayload["options"],
  chain: unknown[],
  frameUrls: Map<string, string>
): Promise<unknown[]> {
  const partials = [scan.partial];
  for (const { frameSelector, frameContext } of scan.frameContexts) {
    let child: unknown[] = [null];
    try {
      const scanned = await raceTimeout(
        scanChildFrame(frame, frameSelector, frameContext, source, options),
        FRAME_SCAN_TIMEOUT_MS
      );
      if (scanned && scanned !== TIMED_OUT) {
        const childChain = [...chain, frameSelector];
        frameUrls.set(frameKey(childChain), scanned.frame.url());
        child = await runPartialInFrames(scanned.frame, scanned.scan, source, options, childChain, frameUrls);
      }
    } catch {
      // Detached or navigated away mid-scan: left untested, like a frame axe can't reach.
    }
    partials.push(...child);
  }
  return partials;
}

/**
 * Axe-core invariant preset. Injects axe into every page the invariant runs
 * on and into its iframes, same- and cross-origin, scans them as one page
 * and fails with a one-line summary of the violations, naming the frame of
 * those inside an iframe. Requires `axe-core` to be installed — it's an
 * optional peer dep; before axe-core 4.3 (no `runPartial`) only the top
 * document is scanned.
 */
export function axe(options: AxeInvariantOptions = {}): Invariant {
  const payload = buildAxeRunPayload(options);
  return {
    name: options.name ?? "a11y-axe",
    urlPattern: options.urlPattern,
    when: options.when ?? "afterActions",
    async check({ page }) {
      const source = await loadAxeSource();
      const main = page.mainFrame();
      // Evaluated over CDP, which the page's Content-Security-Policy does not
      // govern. `page.addScriptTag` inserted an inline <script>, which a
      // `script-src` without 'unsafe-inline' refuses: every page of such a
      // site failed with an injection error that said nothing about a11y.
      await main.evaluate(source);
      const hasRunPartial = await main.evaluate(() => {
        const ax = (globalThis as { axe?: AxeGlobal }).axe;
        if (!ax) throw new Error("axe-core failed to install on the page");
        return typeof ax.runPartial === "function";
      });
      const frameUrls = new Map<string, string>();
      let results: AxeResults;
      if (hasRunPartial) {
        const scan = await scanFrame(main, payload.context, payload.options);
        const partials = await runPartialInFrames(main, scan, source, payload.options, [], frameUrls);
        results = await main.evaluate(
          // `ancestry` puts the frames' selectors on each node, for `frameUrls`.
          (p) => (globalThis as AxeWindow).axe.finishRun(p.partials, { ...p.options, ancestry: true }),
          { partials, options: payload.options }
        );
      } else {
        results = await main.evaluate(
          (p) => (globalThis as AxeWindow).axe.run(p.context ?? document, p.options),
          payload
        );
      }
      if (!results || !Array.isArray(results.violations) || results.violations.length === 0) {
        return true;
      }
      return formatAxeViolations(results.violations, ({ ancestry }) =>
        Array.isArray(ancestry) && ancestry.length > 1 ? frameUrls.get(frameKey(ancestry.slice(0, -1))) : undefined
      );
    },
  };
}

/** Exported as a namespace so consumers can write `invariants.axe(...)`. */
export const invariants = {
  axe,
  visualRegression,
  stateMachine: stateMachineInvariant,
  xssMarker,
  injectedMarkup,
  prototypePollution,
  renderedGarbage,
  notBlank,
  dataSafety,
};
