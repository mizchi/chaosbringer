import { describe, expect, it } from "vitest";
import type { CDPSession, Page } from "playwright";
import { EMIT_BINDING, startSession } from "./session";

// A fake CDP client modelling Chromium's per-client binding set (no reference
// count): commands are applied in the order they are sent.
function fakeClient() {
  const bindings = new Set<string>();
  const log: string[] = [];
  const client = {
    on() {},
    off() {},
    async send(method: string, params?: { name?: string }) {
      log.push(method);
      if (method === "Runtime.addBinding" && params?.name) bindings.add(params.name);
      if (method === "Runtime.removeBinding" && params?.name) bindings.delete(params.name);
      if (method === "Performance.getMetrics") return { metrics: [] };
      return {};
    },
  };
  return { client: client as unknown as CDPSession, bindings, log };
}

// A page whose detach evaluate waits on a gate the test opens.
function gatedPage() {
  let openGate!: () => void;
  const gate = new Promise<void>((r) => (openGate = r));
  let markStarted!: () => void;
  const detachStarted = new Promise<void>((r) => (markStarted = r));
  const page = {
    on() {},
    off() {},
    coverage: undefined,
    url: () => "http://localhost/",
    isClosed: () => false,
    async addInitScript() {
      return { dispose: async () => {} };
    },
    async evaluate(fn: unknown) {
      if (String(fn).includes("detach")) {
        markStarted();
        await gate;
      }
      return null;
    },
  };
  return { page: page as unknown as Page, openGate, detachStarted };
}

describe("startSession binding teardown", () => {
  it("keeps the binding of a session started while the last one's detach is pending", async () => {
    const { client, bindings, log } = fakeClient();
    const { page, openGate, detachStarted } = gatedPage();
    const opts = { oopif: false, awaitPaint: false, installCollector: false };
    const a = await startSession(page, client, opts);
    expect(bindings.has(EMIT_BINDING)).toBe(true);

    // a is the last session on page and client: its finish() awaits the detach.
    const aDone = a.finish("a");
    await detachStarted;
    const b = await startSession(page, client, opts);
    openGate();
    await aDone;
    expect(log.filter((m) => m.includes("Binding"))).toEqual([
      "Runtime.addBinding",
      "Runtime.addBinding",
    ]);
    // b is still open: its binding must still be installed.
    expect(bindings.has(EMIT_BINDING)).toBe(true);

    // b, the client's last session now, removes it.
    await b.finish("b");
    expect(bindings.has(EMIT_BINDING)).toBe(false);
  });
});
