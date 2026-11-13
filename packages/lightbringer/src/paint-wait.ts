import type { Page } from "playwright";
import { raceTimeout } from "./evaluate";

// ---------------------------------------------------------------------------
// A bounded wait for a contentful paint the browser has drawn but not yet
// presented, run after the measured spans have closed.
//
// Chromium creates the `first-contentful-paint` paint entry (and web-vitals'
// FCP after it), and an image's `largest-contentful-paint` entry, only once the
// GPU process reports the frame that drew it as presented. A settle of two
// animation frames does not wait for that, so when presentation lags (a
// stalled GPU process) a read right after the settle finds FCP absent, or LCP
// still on an earlier, smaller candidate. The values are the browser's own
// entry timestamps: a later read can only make an entry exist, never shift it.
//
// The wait runs only when something is pending:
//
//   - `fcp`: no first-contentful-paint entry yet, but the document shows
//     content that paints contentfully — a visible text node, a loaded <img>, a
//     drawn <svg>, a <video> frame or poster, a filled text control — inside
//     the viewport and not clipped away. Canvas, CSS backgrounds, pseudo-
//     elements and iframes never count, so a miss means no wait (the behaviour
//     without this helper), never a wait for something that cannot come.
//   - `fcp-vital`: the raw entry exists, web-vitals has not delivered it yet
//     (one observer task; LCP's first candidate comes in the same task).
//   - `lcp-image`: an image response finished after the current LCP candidate,
//     and a visible, in-viewport image it paints is larger than the candidate
//     after Chromium's own exclusions. Not after the first input: Chromium
//     stops reporting LCP candidates then.
//
// It is paced by animation frames, not by time: a presentation stall holds the
// renderer's frames too, so "a few more frames" stretches through the stall by
// itself, while a page whose expected paint never comes pays only those few
// frames. A Node-side wall-clock cap ends a stall that does not end.
// ---------------------------------------------------------------------------

/**
 * Frames at normal cadence (under 50 ms after the previous one) to wait after
 * the baseline frame. Under a 300 ms GPU-process stall the paint was reported
 * 0-3 such frames after frames resumed.
 */
export const PAINT_WAIT_MAX_FRAMES = 5;
/**
 * Frames of any cadence to wait after the baseline frame: a page whose frames
 * all come late (a busy main thread) stops here instead of at the wall cap.
 */
export const PAINT_WAIT_TOTAL_FRAMES = 8;
/** Frames to wait for web-vitals to deliver an FCP the browser already has. */
export const PAINT_WAIT_VITALS_FRAMES = 3;
/** Wall-clock cap for the whole wait, for frames that stop running. */
export const PAINT_WAIT_MAX_MS = 1000;
/** Wall-clock cap for the read that classifies what was still pending after the cap. */
const CLASSIFY_MAX_MS = 250;

/** What a paint wait still expects. */
export type PaintPending = "fcp" | "fcp-vital" | "lcp-image";

/** The image a pending `lcp-image` expects to become LCP, as estimated in the page. */
export interface PaintLcpImage {
  url: string;
  /** Its estimated LCP size (px², clipped to the viewport). */
  area: number;
  /** The current candidate's size (px²). */
  candidateSize: number;
  /** Encoded bits per displayed pixel (Chromium skips images under 0.05). */
  bpp: number;
}

/** What one in-page check (and, with `maxFrames > 0`, wait) returns. */
interface InPagePaint {
  visible: boolean;
  collector: boolean;
  timeOrigin: number;
  fcp: number | null;
  lcp: number | null;
  pending: PaintPending[];
  content?: string;
  lcpImage?: PaintLcpImage;
  frames: number;
  flowing: number;
}

interface InPageOptions {
  maxFrames: number;
  totalFrames: number;
  vitalsFrames: number;
  /** Wall time the page may still spend, by rAF timestamps. */
  maxMs: number;
}

/**
 * The in-page check and wait. One self-contained function (Playwright
 * serializes it whole, so it closes over nothing), named so `drilldown`
 * labels its samples as harness work. It reads only rAF and its timestamps:
 * never setTimeout, performance.now or Date, which clock-skew faults and
 * timer wrappers patch.
 */
export async function lightbringerAwaitPaint(o: InPageOptions): Promise<InPagePaint> {
  const MIN_AREA = 4;
  // Chromium drops images under 0.05 bits per displayed pixel from LCP; a
  // margin keeps an estimate near the line from waiting.
  const MIN_BPP = 0.055;
  const LCP_MARGIN = 1.1;
  // A no-repeat background at its natural size paints an area the page cannot
  // read (CSS images expose no intrinsic size), so the element's box is only an
  // upper bound: such an image must beat the candidate by far more.
  const UNKNOWN_SIZE_MARGIN = 4;
  const NODE_CAP = 5000;
  const BG_CAP = 3000;
  const FLOWING_GAP_MS = 50;
  type Box = { l: number; t: number; r: number; b: number };
  type Vital = { value: number; attribution?: Record<string, unknown> };
  type Store = { __lb?: boolean; vitals: Record<string, Vital | undefined> };
  const w = window as unknown as { __perf?: Store; webVitals?: unknown };

  const intersect = (a: Box, b: Box): Box | null => {
    const r = { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
    return r.r > r.l && r.b > r.t ? r : null;
  };
  const area = (r: Box | null) => (r ? (r.r - r.l) * (r.b - r.t) : 0);
  const box = (d: DOMRect | DOMRectReadOnly): Box => ({ l: d.left, t: d.top, r: d.right, b: d.bottom });
  const visCache = new Map<Element, boolean>();
  const visible = (el: Element): boolean => {
    const hit = visCache.get(el);
    if (hit !== undefined) return hit;
    const check = (el as Element & { checkVisibility?: (opts: object) => boolean }).checkVisibility;
    let v: boolean;
    if (typeof check === "function") {
      v = check.call(el, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
    } else {
      const cs = getComputedStyle(el);
      v = cs.display !== "none" && cs.visibility === "visible" && cs.opacity !== "0";
    }
    visCache.set(el, v);
    return v;
  };
  // The part of `rect` inside the viewport and every clipping ancestor from
  // `from` up: overflow other than visible, and `clip: rect()`. Any clip-path
  // counts as clipping everything away: its shape cannot be read, and the
  // visually-hidden idioms (circle(0), inset(50%), inset(100%)) all use it.
  const clipped = (from: Element | null, rect: Box): Box | null => {
    let r = intersect(rect, { l: 0, t: 0, r: innerWidth, b: innerHeight });
    let a = from;
    for (let depth = 0; r && a && a !== document.documentElement && depth < 64; depth++, a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.clipPath && cs.clipPath !== "none") return null;
      const ab = a.getBoundingClientRect();
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") r = intersect(r, box(ab));
      if (r && cs.clip && cs.clip !== "auto" && (cs.position === "absolute" || cs.position === "fixed")) {
        const m = /rect\(([^)]*)\)/.exec(cs.clip);
        if (m) {
          const [t, rt, b, l] = m[1]!.split(/[\s,]+/).map((v) => (v === "auto" ? Number.NaN : parseFloat(v)));
          r = intersect(r, {
            l: ab.left + (Number.isNaN(l!) ? 0 : l!),
            t: ab.top + (Number.isNaN(t!) ? 0 : t!),
            r: Number.isNaN(rt!) ? ab.right : ab.left + rt!,
            b: Number.isNaN(b!) ? ab.bottom : ab.top + b!,
          });
        }
      }
    }
    return r;
  };

  const range = document.createRange();
  const textShows = (t: Text): boolean => {
    const p = t.parentElement;
    if (!p || !visible(p)) return false;
    range.selectNodeContents(t);
    for (const rr of Array.from(range.getClientRects())) {
      if (rr.width <= 0 || rr.height <= 0) continue;
      if (area(clipped(p, box(rr))) >= MIN_AREA) return true;
    }
    return false;
  };
  const elementShows = (el: Element): boolean =>
    visible(el) && area(clipped(el.parentElement, box(el.getBoundingClientRect()))) >= MIN_AREA;
  const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "IFRAME", "OBJECT", "EMBED", "CANVAS", "FRAMESET"]);
  const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
  const BUTTON_INPUTS = new Set(["submit", "reset", "button"]);

  // The first content that would make the browser report FCP, or null. Open
  // shadow roots are walked too; past NODE_CAP nodes nothing is expected.
  const content = (): string | null => {
    const roots: Node[] = [document.body ?? document.documentElement];
    let visited = 0;
    while (roots.length > 0) {
      const root = roots.pop()!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
          return SKIP.has((n as Element).tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
        if (++visited > NODE_CAP) return null;
        if (n.nodeType === 3) {
          if (/\S/.test(n.nodeValue ?? "") && textShows(n as Text)) return "text";
          continue;
        }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (sr) roots.push(sr);
        const tag = el.tagName;
        if (tag === "IMG") {
          const img = el as HTMLImageElement;
          if (img.complete && img.naturalWidth > 0 && elementShows(img)) return "img";
        } else if (tag === "svg" || tag === "SVG") {
          if (
            (el as SVGSVGElement).ownerSVGElement === null &&
            el.querySelector("path,rect,circle,ellipse,line,polyline,polygon,text,use,image") &&
            elementShows(el)
          )
            return "svg";
        } else if (tag === "VIDEO") {
          const v = el as HTMLVideoElement;
          if ((v.poster || v.readyState >= 2) && elementShows(v)) return "video";
        } else if (tag === "INPUT") {
          const i = el as HTMLInputElement;
          const type = (i.getAttribute("type") ?? "").toLowerCase();
          if ((BUTTON_INPUTS.has(type) || (TEXT_INPUTS.has(type) && (i.value || i.placeholder))) && elementShows(i))
            return "text";
        } else if (tag === "TEXTAREA") {
          const t = el as HTMLTextAreaElement;
          if ((t.value || t.placeholder) && elementShows(t)) return "text";
        } else if (tag === "SELECT") {
          const s = el as HTMLSelectElement;
          if (s.selectedIndex >= 0 && /\S/.test(s.options[s.selectedIndex]?.text ?? "") && elementShows(s)) return "text";
        }
      }
    }
    return null;
  };

  // A loaded image larger than the current LCP candidate, with no LCP entry yet.
  const lateImage = (store: Store): PaintLcpImage | null => {
    const cand = store.vitals.LCP;
    const entry = cand?.attribution?.lcpEntry as { startTime: number; size: number; url?: string } | undefined;
    const candTime = entry ? entry.startTime : typeof cand?.value === "number" ? cand.value : Number.NEGATIVE_INFINITY;
    const candSize = entry?.size ?? 0;
    const candUrl = entry?.url ?? "";
    const late = new Map<string, PerformanceResourceTiming>();
    for (const r of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      if (r.responseEnd <= candTime || r.name === candUrl || !(r.encodedBodySize > 0)) continue;
      const type = (r as PerformanceResourceTiming & { contentType?: string }).contentType;
      if (type ? !type.startsWith("image/") : r.initiatorType === "script" || r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest")
        continue;
      late.set(r.name, r);
    }
    if (late.size === 0) return null;
    const vpArea = innerWidth * innerHeight;
    // `natural`: an <img>'s intrinsic area. `painted`: a background's painted
    // area when its CSS says (cover, tiled, or a px size), else null.
    const judge = (el: Element, r: PerformanceResourceTiming, natural: number | null, painted?: number | null) => {
      if (!visible(el)) return null;
      const br = el.getBoundingClientRect();
      const shown = area(clipped(el.parentElement, box(br)));
      if (shown < MIN_AREA) return null;
      const drawn = br.width * br.height;
      // An upscaled image counts at its natural size (Chromium scales it down).
      let size = natural !== null && drawn > 0 ? shown * Math.min(1, natural / drawn) : shown;
      if (typeof painted === "number") size = Math.min(size, painted);
      const margin = painted === null ? UNKNOWN_SIZE_MARGIN : LCP_MARGIN;
      const bpp = (r.encodedBodySize * 8) / size;
      if (size <= candSize * margin || bpp < MIN_BPP || shown >= vpArea * 0.99) return null;
      return { url: r.name, area: Math.round(size), candidateSize: candSize, bpp: Math.round(bpp * 100) / 100 };
    };
    // A single background's painted area from its CSS, or null when it
    // depends on the image's intrinsic size.
    const bgPainted = (cs: CSSStyleDeclaration, el: Element): number | null => {
      const r = el.getBoundingClientRect();
      const boxArea = r.width * r.height;
      const repeat = cs.backgroundRepeat.split(",")[0]!.trim();
      const size = cs.backgroundSize.split(",")[0]!.trim();
      if (size === "cover") return boxArea;
      if (repeat !== "no-repeat" && repeat !== "no-repeat no-repeat") return boxArea;
      const px = /^(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px$/.exec(size);
      return px ? Math.min(boxArea, parseFloat(px[1]!) * parseFloat(px[2]!)) : null;
    };
    const matched = new Set<string>();
    for (const img of Array.from(document.images)) {
      const r = late.get(img.currentSrc);
      if (!r) continue;
      matched.add(r.name);
      if (!img.complete || img.naturalWidth === 0) continue;
      const hit = judge(img, r, img.naturalWidth * img.naturalHeight);
      if (hit) return hit;
    }
    if (matched.size === late.size || !document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let seen = 0;
    for (let n = walker.nextNode(); n && seen < BG_CAP; n = walker.nextNode(), seen++) {
      const cs = getComputedStyle(n as Element);
      const bg = cs.backgroundImage;
      if (!bg || bg === "none") continue;
      const urls = [...bg.matchAll(/url\("?([^")]+)"?\)/g)].map((m) => m[1]!);
      for (const u of urls) {
        const r = late.get(u);
        if (!r || matched.has(r.name)) continue;
        const hit = judge(n as Element, r, null, urls.length === 1 ? bgPainted(cs, n as Element) : null);
        if (hit) return hit;
      }
    }
    return null;
  };

  const check = () => {
    const vis =
      document.visibilityState === "visible" && !(document as Document & { prerendering?: boolean }).prerendering;
    const store = w.__perf && w.__perf.__lb === true ? w.__perf : undefined;
    const fcpEntry = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
    const lcpValue = store?.vitals.LCP?.value;
    const out: Omit<InPagePaint, "frames" | "flowing"> = {
      visible: vis,
      collector: store !== undefined,
      timeOrigin: performance.timeOrigin,
      fcp: fcpEntry ? fcpEntry.startTime : null,
      lcp: typeof lcpValue === "number" ? lcpValue : null,
      pending: [],
    };
    if (!vis) return out;
    let hidden = false;
    for (const e of performance.getEntriesByType("visibility-state")) if (e.name === "hidden") hidden = true;
    // web-vitals reports nothing for a document that was ever hidden.
    const vitals = store !== undefined && w.webVitals !== undefined && !hidden;
    if (!fcpEntry) {
      const kind = content();
      if (kind) {
        out.pending.push("fcp");
        out.content = kind;
      }
    } else if (vitals && !store!.vitals.FCP) {
      out.pending.push("fcp-vital");
    }
    // No "LCP vital" wait of its own: web-vitals gets the LCP entry of the
    // first contentful frame in the same observer task as FCP, so a pending
    // FCP vital covers it. After a first input (a click, a key press)
    // Chromium reports no further LCP candidate, so no image is waited for.
    if (vitals && performance.getEntriesByType("first-input").length === 0) {
      const img = lateImage(store!);
      if (img) {
        out.pending.push("lcp-image");
        out.lcpImage = img;
      }
    }
    return out;
  };

  // The deadline's origin is read now, not at the baseline frame: when frames
  // have already stopped as the wait begins (the usual case behind a pending
  // paint), the baseline frame itself comes only after the stall, and a
  // deadline counted from it would let an abandoned loop keep walking the DOM
  // for its whole frame budget. An event's timeStamp shares rAF's timebase,
  // advances while frames are stopped, and is not what clock faults patch.
  const origin = new Event("lightbringer-paint-wait").timeStamp;
  let s = check();
  let frames = 0;
  let flowing = 0;
  if (!s.visible || s.pending.length === 0 || o.maxFrames <= 0) return { ...s, frames, flowing };
  // The budget is frames at normal cadence after the baseline: a frame that
  // comes late (a stall, or a long task) is no chance for the paint to have
  // been reported, so it does not count, and the total-frame cap bounds a page
  // whose frames are all late.
  let prev = await new Promise<number>((r) => requestAnimationFrame(r));
  frames++;
  let fcpAt = -1;
  for (;;) {
    // The caller's wall cap has passed (frames stopped for longer than it):
    // nothing reads this result any more, so stop without walking the DOM
    // again, which would land in whatever the caller measures next. Checked
    // on every frame, the baseline included.
    if (prev - origin > o.maxMs) break;
    s = check();
    if (!s.visible || s.pending.length === 0) break;
    if (s.fcp !== null && fcpAt < 0) fcpAt = frames;
    const vitalsOnly = s.pending.every((p) => p === "fcp-vital");
    if (vitalsOnly && fcpAt >= 0 && frames - fcpAt >= o.vitalsFrames) break;
    if (flowing >= o.maxFrames || frames - 1 >= o.totalFrames) break;
    const ts = await new Promise<number>((r) => requestAnimationFrame(r));
    frames++;
    if (ts - prev < FLOWING_GAP_MS) flowing++;
    prev = ts;
  }
  return { ...s, frames, flowing };
}

/** What `awaitPendingPaint` found and did. */
export interface PaintWaitResult {
  /**
   * `none`: nothing was pending (one in-page check, no wait). `reported`:
   * everything pending arrived. `frames`: the frame budget ran out with
   * something still pending (frames ran, and the browser did not count what
   * the check expected). `timeout`: the wall-clock cap hit (frames stopped:
   * a presentation stall longer than the cap). `hidden`: the document is or
   * went hidden. `error`: an evaluate failed (a navigation, a closed page).
   */
  outcome: "none" | "reported" | "frames" | "timeout" | "hidden" | "error";
  /** The page has lightbringer's collector (LCP needs it); null when the page never answered. */
  collector: boolean | null;
  /** `performance.timeOrigin` of the document the values below are from, to merge only same-document values. */
  timeOrigin: number | null;
  /** The raw first-contentful-paint entry's startTime at the last read, null when absent or not read. */
  fcp: number | null;
  /** web-vitals' LCP at the last read, null when absent or not read. */
  lcp: number | null;
  waitedMs: number;
  /** Animation frames the wait ran, the baseline included; null when the wall cap cut it off. */
  frames: number | null;
  /** Of `frames`, those at normal cadence. */
  flowing?: number;
  /** What was pending at the first check. */
  initial: PaintPending[];
  /** What was still pending when the wait ended. */
  final: PaintPending[];
  /** For a pending FCP: the content that made a paint expected (`text`, `img`, `svg`, `video`). */
  content?: string;
  /** For a pending image LCP: the image, and its estimated size against the candidate's. */
  lcpImage?: PaintLcpImage;
}

export interface AwaitPaintOptions {
  /** Normal-cadence frames after the baseline (default {@link PAINT_WAIT_MAX_FRAMES}). */
  maxFrames?: number;
  /** Frames of any cadence after the baseline (default {@link PAINT_WAIT_TOTAL_FRAMES}). */
  totalFrames?: number;
  /** Frames to wait for web-vitals' FCP once the raw entry exists (default {@link PAINT_WAIT_VITALS_FRAMES}). */
  vitalsFrames?: number;
  /** Wall-clock cap, check included (default {@link PAINT_WAIT_MAX_MS}). */
  maxMs?: number;
  /**
   * Called with the first check's evaluate when the cap abandoned it: the
   * page did not answer at all (a hung document), so a caller that reads the
   * page next can wait on this instead of issuing a read that queues behind it.
   */
  onUnanswered?: (pending: Promise<unknown>) => void;
}

const TIMED_OUT = Symbol("timed out");

/**
 * Check for a pending paint and, when there is one, wait for it: at most
 * `maxFrames` frames at normal cadence and `totalFrames` in all, and at most
 * `maxMs` of wall time on Node's clock. One evaluate when nothing is pending.
 * Never throws. Call it after the spans it must not stretch have closed and
 * before the read that should see the late value.
 */
export async function awaitPendingPaint(page: Page, options: AwaitPaintOptions = {}): Promise<PaintWaitResult> {
  const maxFrames = options.maxFrames ?? PAINT_WAIT_MAX_FRAMES;
  const totalFrames = options.totalFrames ?? PAINT_WAIT_TOTAL_FRAMES;
  const vitalsFrames = options.vitalsFrames ?? PAINT_WAIT_VITALS_FRAMES;
  const maxMs = options.maxMs ?? PAINT_WAIT_MAX_MS;
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  const unread = { collector: null, timeOrigin: null, fcp: null, lcp: null } as const;
  // Issued evaluates are never cancelled: one the cap abandons settles later,
  // and its rejection must not surface as unhandled.
  let issued: Promise<unknown> | undefined;
  const evaluate = (args: InPageOptions, ms: number): Promise<InPagePaint | typeof TIMED_OUT> => {
    const p = page.evaluate(lightbringerAwaitPaint, args);
    p.catch(() => {});
    issued = p;
    return raceTimeout(p, Math.max(0, ms), (): typeof TIMED_OUT => TIMED_OUT);
  };
  const quickArgs = { maxFrames: 0, totalFrames: 0, vitalsFrames, maxMs: 0 };

  let first: InPagePaint;
  try {
    const quick = await evaluate(quickArgs, maxMs);
    if (quick === TIMED_OUT) {
      if (issued) options.onUnanswered?.(issued);
      return { outcome: "timeout", ...unread, waitedMs: elapsed(), frames: 0, initial: [], final: [] };
    }
    first = quick;
  } catch {
    return { outcome: "error", ...unread, waitedMs: elapsed(), frames: 0, initial: [], final: [] };
  }
  const read = (r: InPagePaint) => ({ collector: r.collector, timeOrigin: r.timeOrigin, fcp: r.fcp, lcp: r.lcp });
  const found = {
    ...(first.content ? { content: first.content } : {}),
    ...(first.lcpImage ? { lcpImage: first.lcpImage } : {}),
  };
  if (!first.visible)
    return { outcome: "hidden", ...read(first), waitedMs: elapsed(), frames: 0, initial: [], final: [] };
  if (first.pending.length === 0)
    return { outcome: "none", ...read(first), waitedMs: elapsed(), frames: 0, initial: [], final: [] };

  const left = maxMs - elapsed();
  let done: InPagePaint | typeof TIMED_OUT;
  try {
    done = await evaluate({ maxFrames, totalFrames, vitalsFrames, maxMs: left }, left);
  } catch {
    return { outcome: "error", ...unread, waitedMs: elapsed(), frames: 0, initial: first.pending, final: first.pending, ...found };
  }
  if (done === TIMED_OUT) {
    // Frames stopped for longer than the cap. One quick read says what is
    // still pending (the main thread answers during a presentation stall);
    // when it cannot answer either, what was pending at the start stands.
    let late: InPagePaint | typeof TIMED_OUT = TIMED_OUT;
    try {
      late = await evaluate(quickArgs, CLASSIFY_MAX_MS);
    } catch {
      // The page went away: same as no answer.
    }
    const waitedMs = elapsed();
    if (late === TIMED_OUT)
      return { outcome: "timeout", ...unread, waitedMs, frames: null, initial: first.pending, final: first.pending, ...found };
    return {
      outcome: "timeout",
      ...read(late),
      waitedMs,
      frames: null,
      initial: first.pending,
      final: late.pending,
      ...found,
      ...(late.lcpImage ? { lcpImage: late.lcpImage } : {}),
    };
  }
  const outcome = !done.visible ? "hidden" : done.pending.length === 0 ? "reported" : "frames";
  return {
    outcome,
    ...read(done),
    waitedMs: elapsed(),
    frames: done.frames,
    flowing: done.flowing,
    initial: first.pending,
    final: done.pending,
    ...found,
  };
}

/** A paint wait as a report records it: rounded, with empty parts left out. */
export interface PaintWaitRecord {
  outcome: PaintWaitResult["outcome"];
  waitedMs: number;
  /** Frames the wait ran, the baseline included; absent when the wall cap cut it off. */
  frames?: number;
  flowing?: number;
  /** What was pending when the wait began. */
  pending: PaintPending[];
  /** What was still pending when it ended; absent when everything arrived. */
  stillPending?: PaintPending[];
  content?: string;
  lcpImage?: PaintLcpImage;
}

/** The record of a wait, for a report (`PerfReport.paintWait`, chaosbringer's `PageResult.paintWait`). */
export function paintWaitRecord(r: PaintWaitResult): PaintWaitRecord {
  return {
    outcome: r.outcome,
    waitedMs: Math.round(r.waitedMs * 10) / 10,
    ...(r.frames !== null ? { frames: r.frames } : {}),
    ...(r.flowing !== undefined ? { flowing: r.flowing } : {}),
    pending: r.initial,
    ...(r.final.length > 0 ? { stillPending: r.final } : {}),
    ...(r.content ? { content: r.content } : {}),
    ...(r.lcpImage ? { lcpImage: r.lcpImage } : {}),
  };
}
