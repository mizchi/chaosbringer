/**
 * Per-page network sampler. Listens for `response` events and records
 * a sample per main-document / xhr / fetch response: URL key, status,
 * latency in ms. Errors (`requestfailed`) are recorded as a sample
 * with `status: 0`.
 *
 * URL keying intentionally strips the query string and pathname digits
 * so `/api/users/42` and `/api/users/43` aggregate into a single
 * endpoint row. Without this the EndpointReport explodes for any app
 * with id-bearing URLs.
 *
 * Memory: each sample is small (~40 bytes) and the runner drains the
 * sampler at iteration end, so steady-state memory is per-iteration
 * not per-run.
 */
import type { Page, Request, Response } from "playwright";

export interface NetworkSample {
  /** URL key (path with numeric segments replaced by `:id`). */
  key: string;
  /** Full URL — kept for debugging, not aggregated. */
  url: string;
  /** HTTP status, or 0 for network failures. */
  status: number;
  /** Wall-clock duration in ms from request fired → response received. */
  durationMs: number;
  /** Sample wall-clock at response receive time. */
  timestamp: number;
}

export class NetworkSampler {
  private samples: NetworkSample[] = [];
  private starts = new WeakMap<Request, number>();
  private detach: (() => void) | null = null;

  attach(page: Page): void {
    if (this.detach) this.detach();
    const onRequest = (req: Request) => {
      this.starts.set(req, performance.now());
    };
    const onResponse = (res: Response) => {
      const req = res.request();
      const start = this.starts.get(req);
      const end = performance.now();
      if (start === undefined) return;
      const url = res.url();
      // Filter data: / blob: — not meaningful for endpoint rollups.
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      this.samples.push({
        key: endpointKey(url),
        url,
        status: res.status(),
        durationMs: end - start,
        timestamp: Date.now(),
      });
    };
    const onFailed = (req: Request) => {
      const start = this.starts.get(req);
      const end = performance.now();
      if (start === undefined) return;
      const url = req.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      this.samples.push({
        key: endpointKey(url),
        url,
        status: 0,
        durationMs: end - start,
        timestamp: Date.now(),
      });
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onFailed);
    this.detach = () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
    };
  }

  /** Return and clear the buffer. */
  drain(): NetworkSample[] {
    const out = this.samples;
    this.samples = [];
    return out;
  }

  /** Stop listening. The page handle MUST still be alive when this runs. */
  stop(): void {
    if (this.detach) {
      this.detach();
      this.detach = null;
    }
  }
}

/**
 * Reduce `/api/users/42/orders/abc-123` → `/api/users/:id/orders/:id`.
 * Strips query / fragment. Lowercases nothing — case is significant
 * for many APIs.
 */
export function endpointKey(rawUrl: string): string {
  let path: string;
  try {
    const u = new URL(rawUrl);
    path = u.pathname || "/";
  } catch {
    // Relative URL — fall back to the raw input minus query.
    const q = rawUrl.indexOf("?");
    path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  }
  return path
    .split("/")
    .map((segment) => {
      if (segment === "") return "";
      // Pure-numeric → :id
      if (/^\d+$/.test(segment)) return ":id";
      // UUID-ish → :uuid
      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment)) {
        return ":uuid";
      }
      // Hex token longer than 12 chars → :hex
      if (/^[0-9a-fA-F]{12,}$/.test(segment)) return ":hex";
      return segment;
    })
    .join("/");
}
