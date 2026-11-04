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

  /** Buffer the fault the headers describe, and return it (null for none). */
  observe(args: ObserveArgs): ServerFaultEvent | null {
    const parsed = parseServerFaultHeaders(args.headers, this.prefix);
    if (!parsed) return null;
    const event: ServerFaultEvent = {
      traceId: parsed.traceId,
      attrs: parsed.attrs,
      observedAt: Date.now(),
      pageUrl: args.pageUrl,
    };
    this.buffer.push(event);
    return event;
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
