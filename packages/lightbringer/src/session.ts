import type { CDPSession, Page } from "playwright";
import { webVitalsIife } from "./config";
import { DEFAULT_EVALUATE_TIMEOUT_MS, type NetProfile } from "./defaults";
import { BoundedEvaluator } from "./evaluate";
import {
  browserCollector,
  type CollectorOptions,
  type DrainPayload,
} from "./browser";
import { PerfController } from "./controller";
import { PerfAccumulator } from "./accumulator";
import { startNetworkCapture, startTrace } from "./capture";
import { buildReport, buildSpanReport, firstPartyDomainOf } from "./report";
import {
  buildCoverage,
  type Coverage,
  type CoverageArtifact,
  type JSCoverageEntry,
  type CSSCoverageEntry,
} from "./analyze/coverage";
import type {
  CssProfile,
  MediaReport,
  PerfReport,
  RenderBlocking,
  Settle,
  SpanReport,
} from "./report-types";

// ---------------------------------------------------------------------------
// Reusable measurement session. Works with any Playwright Page + CDPSession, so
// the collection logic isn't tied to @playwright/test — the fixture (src/fixture.ts)
// and the CLI driver (src/cli.ts) both build on it.
// ---------------------------------------------------------------------------

export interface SessionOptions {
  /** CPU throttling multiplier (1 = off) */
  cpuRate?: number;
  /** network emulation profile (bytes/s, ms), or null for none */
  netProfile?: NetProfile | null;
  /** add per-selector SelectorStats to the trace (requires trace) */
  cssStats?: boolean;
  /** capture a Chrome trace, streamed to tracePath */
  trace?: boolean;
  /** where to stream the trace (required when trace is true) */
  tracePath?: string;
  /** record JS/CSS coverage across the scenario */
  coverage?: boolean;
  /** force a GC at span boundaries (retained-only memory deltas) */
  memGc?: boolean;
  /** max time to wait for settle before marking a span capped (ms, default 5000) */
  settleTimeoutMs?: number;
  /** default settle for measure()/end() (default: two animation frames) */
  settle?: Settle;
  /**
   * max time one in-page read (page.evaluate) at a span boundary or in finish()
   * may take before its fallback is used (ms, default 5000). A page whose
   * document request never answers otherwise holds every read for minutes.
   */
  evaluateTimeoutMs?: number;
  /**
   * Install the in-page collector with page.addInitScript (default true). Pass
   * false when the caller already installed collectorInitScript() at CONTEXT
   * level — before its own init scripts, so the collector captures the unpatched
   * clock (e.g. ahead of a clock-skew runtime fault).
   */
  installCollector?: boolean;
}

/** Name of the CDP binding the collector pushes an unloading document's data through. */
export const EMIT_BINDING = "__lbEmit";

const collectorScriptCache = new Map<boolean, string>();

/**
 * The complete in-page collector (web-vitals IIFE + collector invocation) as an
 * init-script string, for callers that install it themselves — typically with
 * `context.addInitScript({ content: collectorInitScript() })` ahead of other init
 * scripts, combined with `startSession(..., { installCollector: false })`.
 * Idempotent per document: injecting it twice registers the observers once.
 *
 * `frames: false` leaves the rAF frame probe off until a span begins (see
 * PerfStore.startFrames), for a collector that is installed on every page but
 * only occasionally measured. Default true.
 */
export function collectorInitScript(opts: CollectorOptions = {}): string {
  const frames = opts.frames !== false;
  let script = collectorScriptCache.get(frames);
  if (script === undefined) {
    // The options object is inlined as a literal: the collector runs inside the
    // page, so it cannot close over anything on the node side.
    const arg = frames ? "" : JSON.stringify({ frames: false });
    script = `${webVitalsIife()}\n;(${browserCollector.toString()})(${arg});\n`;
    collectorScriptCache.set(frames, script);
  }
  return script;
}

export interface PerfSession {
  controller: PerfController;
  /** uncaught page errors observed during the run */
  pageErrors: string[];
  /**
   * The report of `controller.spans[index]` from what the session has gathered
   * so far, without finishing it — for a driver that decides its next step by
   * what the last one cost. `end()` drained the page before recording the
   * span, so its long tasks and interactions are in; a request still in
   * flight counts without its bytes, and trace-level paint / GPU numbers are
   * left out (the trace is only read at `finish`). Pure node-side filtering:
   * no page or CDP call. Undefined for an index with no recorded span.
   */
  peekSpan: (index: number) => SpanReport | undefined;
  /** finalize: gather everything and build the report (`title` labels it) */
  finish: (title: string) => Promise<{
    report: PerfReport;
    covArtifact?: CoverageArtifact;
  }>;
}

/** The browser-side eval bodies, shared verbatim by finish(). */
function readGlRenderer(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string);
  } catch {
    return null;
  }
}
function readCssProfile(): CssProfile {
  let cssRules = 0;
  let selectors = 0;
  let styleSheets = 0;
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const sel = (rule as CSSStyleRule).selectorText;
      if (sel) {
        cssRules += 1;
        selectors += sel.split(",").length;
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) walk(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    styleSheets += 1;
    try {
      walk(sheet.cssRules);
    } catch {
      /* cross-origin stylesheet — rules not readable */
    }
  }
  return {
    styleSheets,
    cssRules,
    selectors,
    domNodes: document.getElementsByTagName("*").length,
  };
}
function readMedia(): MediaReport {
  const res = performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
  const byUrl = new Map(res.map((r) => [r.name, r]));
  const dpr = window.devicePixelRatio || 1;
  let imageCount = 0;
  let imageBytes = 0;
  const oversized: MediaReport["oversized"] = [];
  for (const img of Array.from(document.images)) {
    const url = img.currentSrc || img.src;
    const nW = img.naturalWidth;
    const nH = img.naturalHeight;
    if (!url || !nW || !nH) continue;
    imageCount += 1;
    const r = byUrl.get(url);
    const bytes = r ? r.encodedBodySize || r.transferSize || 0 : 0;
    imageBytes += bytes;
    const rect = img.getBoundingClientRect();
    const rW = Math.round(rect.width);
    const rH = Math.round(rect.height);
    if (rW > 0 && rH > 0) {
      const overFetch = (nW * nH) / (rW * rH * dpr * dpr);
      if (overFetch >= 4) {
        oversized.push({
          url,
          naturalPx: `${nW}x${nH}`,
          renderedPx: `${rW}x${rH}`,
          overFetch: Math.round(overFetch * 10) / 10,
          kb: Math.round(bytes / 102.4) / 10,
        });
      }
    }
  }
  oversized.sort((a, b) => b.kb - a.kb);
  const textType = new Set([
    "script",
    "link",
    "css",
    "fetch",
    "xmlhttprequest",
    "other",
  ]);
  const uncompressed: MediaReport["uncompressed"] = [];
  for (const r of res) {
    if (!textType.has(r.initiatorType)) continue;
    const enc = r.encodedBodySize;
    const dec = r.decodedBodySize;
    if (!enc || !dec || enc < 20_000) continue; // skip tiny / cross-origin (no TAO)
    const ratio = dec / enc;
    if (ratio < 1.1) {
      uncompressed.push({
        url: r.name,
        kb: Math.round(enc / 102.4) / 10,
        ratio: Math.round(ratio * 100) / 100,
        type: r.initiatorType,
      });
    }
  }
  uncompressed.sort((a, b) => b.kb - a.kb);
  return {
    imageCount,
    imageKB: Math.round(imageBytes / 102.4) / 10,
    oversized: oversized.slice(0, 10),
    uncompressed: uncompressed.slice(0, 10),
  };
}
function readRenderBlocking(): RenderBlocking {
  const stylesheets: string[] = [];
  const scripts: string[] = [];
  const head = document.head;
  if (head) {
    for (const link of Array.from(
      head.querySelectorAll<HTMLLinkElement>("link[rel~=stylesheet]"),
    )) {
      if (link.hasAttribute("disabled")) continue;
      const m = (link.getAttribute("media") || "all").toLowerCase();
      if (m === "all" || m === "screen" || m === "")
        stylesheets.push(link.getAttribute("href") || "");
    }
    for (const s of Array.from(
      head.querySelectorAll<HTMLScriptElement>("script[src]"),
    )) {
      if (
        !s.hasAttribute("async") &&
        !s.hasAttribute("defer") &&
        (s.getAttribute("type") || "") !== "module"
      )
        scripts.push(s.getAttribute("src") || "");
    }
  }
  return { stylesheets, scripts };
}

export async function startSession(
  page: Page,
  client: CDPSession,
  opts: SessionOptions = {},
): Promise<PerfSession> {
  const cpuRate = opts.cpuRate ?? 1;
  const memGc = opts.memGc ?? false;

  if (opts.installCollector !== false)
    await page.addInitScript({ content: collectorInitScript() });

  const accumulator = new PerfAccumulator();
  // An unloading document pushes its undrained remainder through this binding
  // (pagehide / visibilitychange→hidden), so navigating mid-span loses nothing.
  const onBinding = (e: unknown) => {
    const ev = e as { name?: string; payload?: string };
    if (ev.name !== EMIT_BINDING || typeof ev.payload !== "string") return;
    try {
      accumulator.add(JSON.parse(ev.payload) as DrainPayload);
    } catch {
      /* malformed payload: ignore */
    }
  };
  client.on("Runtime.bindingCalled", onBinding);
  // The binding is only exposed to (and reported from) pages while this
  // session's Runtime domain is enabled.
  await client.send("Runtime.enable").catch(() => {});
  await client.send("Runtime.addBinding", { name: EMIT_BINDING }).catch(() => {});

  // A broken / stale build typically throws; capture it so the report can warn.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await client.send("Performance.enable");
  if (cpuRate > 1)
    await client.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  const finishNetwork = await startNetworkCapture(client);
  if (opts.netProfile) {
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      ...opts.netProfile,
    });
  }
  const finishTrace =
    opts.trace && opts.tracePath
      ? await startTrace(client, opts.tracePath, opts.cssStats ?? false)
      : undefined;
  // Coverage spans the whole scenario (resetOnNavigation:false). Chromium-only.
  if (opts.coverage && page.coverage) {
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: false,
    });
    await page.coverage.startCSSCoverage({ resetOnNavigation: false });
  }

  // One evaluator for the controller and finish(): a read that timed out in
  // end() makes finish()'s reads return at once while the page is still hung.
  const evaluator = new BoundedEvaluator(
    page,
    opts.evaluateTimeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS,
  );
  const controller = new PerfController(page, client, {
    settle: opts.settle,
    memGc,
    settleTimeoutMs: opts.settleTimeoutMs,
    accumulator,
    evaluator,
  });

  const finish = async (title: string) => {
    // Final drain of the current document (flushes pending observer records).
    await controller.drain();
    client.off("Runtime.bindingCalled", onBinding);
    // Each read falls back (as a failed evaluate always did) on timeout too.
    const glRenderer = await evaluator.evaluate<string | null>(readGlRenderer, () => null);
    const css = await evaluator.evaluate<CssProfile | undefined>(
      readCssProfile,
      () => undefined,
    );

    let coverage: Coverage | undefined;
    let covArtifact: CoverageArtifact | undefined;
    if (opts.coverage && page.coverage) {
      const jsCov = await page.coverage.stopJSCoverage().catch(() => []);
      const cssCov = await page.coverage.stopCSSCoverage().catch(() => []);
      const built = buildCoverage(
        jsCov as unknown as JSCoverageEntry[],
        cssCov as unknown as CSSCoverageEntry[],
      );
      coverage = built.coverage;
      covArtifact = built.artifact;
    }

    const media = await evaluator.evaluate<MediaReport | undefined>(
      readMedia,
      () => undefined,
    );
    const renderBlocking = await evaluator.evaluate<RenderBlocking | undefined>(
      readRenderBlocking,
      () => undefined,
    );

    const url = page.url();
    const reqs = finishNetwork();
    const renderEvents = finishTrace
      ? (await finishTrace()).renderEvents
      : undefined;

    const report = buildReport(
      title,
      url,
      accumulator,
      controller.spans,
      reqs,
      renderEvents,
    );

    if (css) report.css = css;
    if (
      renderBlocking &&
      (renderBlocking.stylesheets.length || renderBlocking.scripts.length)
    )
      report.renderBlocking = renderBlocking;
    if (
      media &&
      (media.oversized.length || media.uncompressed.length || media.imageCount)
    )
      report.media = media;
    if (coverage) report.coverage = coverage;
    if (glRenderer) report.glRenderer = glRenderer;
    if (pageErrors.length) report.pageErrors = pageErrors;
    if (Object.keys(controller.vitalsBudget).length > 0)
      report.vitalsBudget = controller.vitalsBudget;
    if (!accumulator.sawDocument) report.collectorMissing = true;
    if (accumulator.clockPatched) report.clockPatched = true;
    if (opts.trace && opts.tracePath) report.tracePath = opts.tracePath;

    return { report, covArtifact };
  };

  const peekSpan = (index: number): SpanReport | undefined => {
    const raw = controller.spans[index];
    if (!raw) return undefined;
    let url = "";
    try {
      url = page.url();
    } catch {
      // A closed page: every request counts as first-party, as with no host.
    }
    // `finishNetwork` only snapshots the capture; it stops nothing.
    return buildSpanReport(raw, accumulator, finishNetwork(), firstPartyDomainOf(url));
  };

  return { controller, pageErrors, peekSpan, finish };
}
