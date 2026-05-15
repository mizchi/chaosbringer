/**
 * Stream transforms used by the `partial` and (future) `slowStream`
 * fault verdicts. Operate on Web Standard `ReadableStream<Uint8Array>` so
 * they compose cleanly with `Response.body` on Hono / Workers / Bun.
 *
 * Kept in their own module so the Hono adapter is the only file that
 * pulls them in — the core `server-faults.ts` stays free of stream
 * machinery for runtimes that never see these verdicts.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wrap `source` in a stream that emits at most `afterBytes` bytes of the
 * source, then closes (no error). The truncation point is a raw-byte
 * boundary — multi-byte UTF-8 sequences may be split. That mirrors the
 * real-world failure (upstream cut, pod evicted mid-chunk) we want to
 * exercise: silent body truncation is the bug consumers must detect.
 *
 * If `source` is `null` (handler set no body) the result is an empty
 * stream that closes immediately. If `afterBytes` is `0` the body is
 * dropped entirely after the headers — which is the worst-case "client
 * has Content-Length but receives zero bytes" scenario.
 */
export function truncateStream(
  source: ReadableStream<Uint8Array> | null,
  afterBytes: number,
): ReadableStream<Uint8Array> {
  if (!source) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
  const reader = source.getReader();
  let remaining = Math.max(0, afterBytes);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        // Best-effort: signal the upstream that we are done. Some sources
        // (e.g. backed by a request body) keep producing until cancelled.
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value.byteLength <= remaining) {
        remaining -= value.byteLength;
        controller.enqueue(value);
        if (remaining <= 0) {
          controller.close();
          await reader.cancel();
        }
        return;
      }
      controller.enqueue(value.subarray(0, remaining));
      remaining = 0;
      controller.close();
      await reader.cancel();
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * Wrap `source` in a stream that emits each chunk with `chunkDelayMs` of
 * sleep between. Status + headers are NOT delayed — they leave the
 * server immediately — so the consumer experiences "fast start, slow
 * body", which is the realistic congested-backend / throttled-pod
 * shape that whole-request `latencyMs` cannot reproduce.
 *
 * If `chunkSize` is set, the source is rechunked to fixed-size pieces
 * before delaying — useful when the handler emits a single large buffer
 * but you want the slowness spread across many small chunks. Omitting
 * `chunkSize` preserves whatever chunking the source emits.
 *
 * The delay is applied BEFORE enqueueing each chunk (including the
 * first), so a body with one chunk of N bytes and `chunkDelayMs=100`
 * waits 100ms before any body bytes leave.
 */
export function slowStream(
  source: ReadableStream<Uint8Array> | null,
  opts: { chunkDelayMs: number; chunkSize?: number },
): ReadableStream<Uint8Array> {
  if (!source) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
  const reader = source.getReader();
  const chunkSize = opts.chunkSize;
  // When chunkSize is set, we may have leftover bytes from the previous
  // source chunk that didn't fit a full output chunk yet.
  let pending: Uint8Array | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunkSize === undefined) {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        await sleep(opts.chunkDelayMs);
        controller.enqueue(value);
        return;
      }
      // Rechunking branch: accumulate from source until we have `chunkSize`
      // bytes, emit one chunk, sleep, repeat. On source EOF emit whatever
      // remains as the last (possibly short) chunk.
      while (true) {
        if (pending && pending.byteLength >= chunkSize) {
          const out = pending.subarray(0, chunkSize);
          pending = pending.byteLength > chunkSize ? pending.subarray(chunkSize) : null;
          await sleep(opts.chunkDelayMs);
          controller.enqueue(out);
          return;
        }
        const { value, done } = await reader.read();
        if (done) {
          if (pending && pending.byteLength > 0) {
            const out = pending;
            pending = null;
            await sleep(opts.chunkDelayMs);
            controller.enqueue(out);
            return;
          }
          controller.close();
          return;
        }
        if (!pending) {
          pending = value;
        } else {
          const merged = new Uint8Array(pending.byteLength + value.byteLength);
          merged.set(pending, 0);
          merged.set(value, pending.byteLength);
          pending = merged;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
