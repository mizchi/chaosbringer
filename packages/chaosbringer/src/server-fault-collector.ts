import { parseServerFaultHeaders } from "./server-fault-events.js";
import type { ServerFaultEvent } from "./types.js";

export interface ObserveArgs {
  headers: Headers;
  pageUrl: string;
}

/**
 * Buffers server-side fault events parsed from response headers across
 * the lifetime of a single crawl. The crawler creates one instance,
 * page-level listeners feed it, and the report generator drains it.
 */
export class ServerFaultCollector {
  private buffer: ServerFaultEvent[] = [];

  constructor(private readonly prefix: string) {}

  observe(args: ObserveArgs): void {
    const parsed = parseServerFaultHeaders(args.headers, this.prefix);
    if (!parsed) return;
    this.buffer.push({
      traceId: parsed.traceId,
      attrs: parsed.attrs,
      observedAt: Date.now(),
      pageUrl: args.pageUrl,
    });
  }

  drain(): ServerFaultEvent[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  size(): number {
    return this.buffer.length;
  }
}
