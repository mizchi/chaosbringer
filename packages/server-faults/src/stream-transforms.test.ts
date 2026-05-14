import { describe, expect, it } from "vitest";
import { truncateStream } from "./stream-transforms.js";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const out: number[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const b of value) out.push(b);
  }
  return new Uint8Array(out);
}

describe("truncateStream", () => {
  it("emits exactly N bytes when source is longer", async () => {
    const src = streamFromChunks([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]);
    const out = await readAll(truncateStream(src, 5));
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("emits the whole source when source is shorter than N", async () => {
    const src = streamFromChunks([new Uint8Array([1, 2, 3])]);
    const out = await readAll(truncateStream(src, 100));
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it("emits zero bytes when N=0 (worst-case: declared content but empty body)", async () => {
    const src = streamFromChunks([new Uint8Array([1, 2, 3, 4])]);
    const out = await readAll(truncateStream(src, 0));
    expect(out.byteLength).toBe(0);
  });

  it("returns an empty stream when source is null", async () => {
    const out = await readAll(truncateStream(null, 100));
    expect(out.byteLength).toBe(0);
  });

  it("cuts mid-chunk on byte boundary (splits multi-byte UTF-8 sequences)", async () => {
    // "あ" in UTF-8 is 0xe3 0x81 0x82 (3 bytes). Cutting at 2 bytes leaves
    // an invalid UTF-8 prefix — that is the realistic failure mode we
    // want to expose, not a bug.
    const src = streamFromChunks([new Uint8Array([0xe3, 0x81, 0x82])]);
    const out = await readAll(truncateStream(src, 2));
    expect(Array.from(out)).toEqual([0xe3, 0x81]);
  });
});
