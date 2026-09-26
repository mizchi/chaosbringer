import { EventEmitter } from "node:events";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { installNavigationGuard } from "./navigation-guard.js";

/** A CDP session that records sends and lets the test emit events on it. */
function fakeSession() {
  const emitter = new EventEmitter();
  const sends: Array<{ method: string; params?: unknown }> = [];
  const session = Object.assign(emitter, {
    async send(method: string, params?: unknown) {
      sends.push({ method, params });
      return {};
    },
    async detach() {},
  });
  return { session: session as unknown as CDPSession, emit: (e: string, p: unknown) => emitter.emit(e, p), sends };
}

function fakePage(session: CDPSession) {
  const page = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const context = { newCDPSession: async () => session } as unknown as BrowserContext;
  page.context = () => context;
  page.mainFrame = () => undefined;
  return page as unknown as Page;
}

const tick = () => new Promise((r) => setImmediate(r));

describe("installNavigationGuard", () => {
  it("pauses documents only, fails external ones, continues the rest", async () => {
    const { session, emit, sends } = fakeSession();
    const blocked: string[] = [];
    const guard = await installNavigationGuard(fakePage(session), {
      isExternal: (url) => !url.startsWith("http://app.test"),
      onBlocked: (url) => blocked.push(url),
    });
    expect(sends[0]).toEqual({
      method: "Fetch.enable",
      params: { patterns: [{ resourceType: "Document", requestStage: "Request" }] },
    });

    emit("Fetch.requestPaused", { requestId: "1", request: { url: "http://app.test/a" } });
    emit("Fetch.requestPaused", { requestId: "2", request: { url: "https://elsewhere.test/" } });
    // A redirect hop is not re-decided, as Playwright never routes redirects.
    emit("Fetch.requestPaused", {
      requestId: "3",
      request: { url: "https://elsewhere.test/r" },
      redirectedRequestId: "1",
    });
    await tick();

    expect(blocked).toEqual(["https://elsewhere.test/"]);
    expect(sends.slice(1)).toEqual([
      { method: "Fetch.continueRequest", params: { requestId: "1" } },
      { method: "Fetch.failRequest", params: { requestId: "2", errorReason: "BlockedByClient" } },
      { method: "Fetch.continueRequest", params: { requestId: "3" } },
    ]);

    await guard.dispose();
    expect(sends.at(-1)?.method).toBe("Fetch.disable");
    emit("Fetch.requestPaused", { requestId: "4", request: { url: "https://elsewhere.test/" } });
    await tick();
    expect(blocked).toHaveLength(1);
  });
});
