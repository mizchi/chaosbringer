/**
 * Stream transforms used by the `partial` and (future) `slowStream`
 * fault verdicts. Operate on Web Standard `ReadableStream<Uint8Array>` so
 * they compose cleanly with `Response.body` on Hono / Workers / Bun.
 *
 * Kept in their own module so the Hono adapter is the only file that
 * pulls them in — the core `server-faults.ts` stays free of stream
 * machinery for runtimes that never see these verdicts.
 */

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
