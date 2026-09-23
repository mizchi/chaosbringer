import type { CDPSession, Page } from "playwright";
import { CSS_STATS, MEM_GC, WEB_VITALS_IIFE } from "./config";
import { browserCollector, type PerfWindow } from "./browser";
import { PerfController } from "./controller";
import { startNetworkCapture, startTrace } from "./capture";
import { buildReport } from "./report";
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
  netProfile?: {
    latency: number;
    downloadThroughput: number;
    uploadThroughput: number;
  } | null;
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
}

export interface PerfSession {
  controller: PerfController;
  /** uncaught page errors observed during the run */
  pageErrors: string[];
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
  const memGc = opts.memGc ?? MEM_GC;

  await page.addInitScript({ content: WEB_VITALS_IIFE });
  await page.addInitScript(browserCollector);

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
      ? await startTrace(client, opts.tracePath, opts.cssStats ?? CSS_STATS)
      : undefined;
  // Coverage spans the whole scenario (resetOnNavigation:false). Chromium-only.
  if (opts.coverage && page.coverage) {
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: false,
    });
    await page.coverage.startCSSCoverage({ resetOnNavigation: false });
  }

  const controller = new PerfController(page, client, undefined, memGc);

  const finish = async (title: string) => {
    // Drain pending PerformanceObserver records first (callbacks are async).
    await page
      .evaluate(() => (window as unknown as PerfWindow).__perf?.flush?.())
      .catch(() => {});
    const raw = await page
      .evaluate(() => (window as unknown as PerfWindow).__perf)
      .catch(() => undefined);
    const timeOrigin = await page
      .evaluate(() => performance.timeOrigin)
      .catch(() => 0);
    const glRenderer = await page.evaluate(readGlRenderer).catch(() => null);
    const css = await page.evaluate(readCssProfile).catch(() => undefined);

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

    const media = await page.evaluate(readMedia).catch(() => undefined);
    const renderBlocking = await page
      .evaluate(readRenderBlocking)
      .catch(() => undefined);

    const url = page.url();
    const reqs = finishNetwork();
    const renderEvents = finishTrace
      ? (await finishTrace()).renderEvents
      : undefined;

    const report = buildReport(
      title,
      url,
      raw ?? {
        vitals: {},
        longTasks: [],
        loaf: [],
        measures: [],
        events: [],
        frames: [],
      },
      timeOrigin,
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
    if (raw === undefined) report.collectorMissing = true;
    if (opts.trace && opts.tracePath) report.tracePath = opts.tracePath;

    return { report, covArtifact };
  };

  return { controller, pageErrors, finish };
}
