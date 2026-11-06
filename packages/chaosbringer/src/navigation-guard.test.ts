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
      return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "MAIN" } } } : {};
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
    expect(sends.map((s) => s.method)).toEqual(["Page.enable", "Page.getFrameTree", "Fetch.enable"]);
    expect(sends[2]).toEqual({
      method: "Fetch.enable",
      params: { patterns: [{ resourceType: "Document", requestStage: "Request" }] },
    });
    sends.splice(0, 2);

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

  it("reports whether a blocked navigation was the main frame's, and the browser's reason for it", async () => {
    const { session, emit } = fakeSession();
    const blocked: Array<[string, unknown]> = [];
    await installNavigationGuard(fakePage(session), {
      isExternal: (url) => !url.startsWith("http://app.test"),
      onBlocked: (url, info) => blocked.push([url, info]),
    });
    // The page asks for the navigation, then its request is paused.
    emit("Page.frameRequestedNavigation", { url: "https://elsewhere.test/a#x", reason: "metaTagRefresh", frameId: "MAIN" });
    emit("Fetch.requestPaused", { requestId: "1", frameId: "MAIN", request: { url: "https://elsewhere.test/a" } });
    emit("Fetch.requestPaused", { requestId: "2", frameId: "SUB", request: { url: "https://elsewhere.test/embed" } });
    // The reason is used once.
    emit("Fetch.requestPaused", { requestId: "3", frameId: "MAIN", request: { url: "https://elsewhere.test/a" } });
    await tick();
    expect(blocked).toEqual([
      ["https://elsewhere.test/a", { mainFrame: true, reason: "metaTagRefresh" }],
      ["https://elsewhere.test/embed", { mainFrame: false }],
      ["https://elsewhere.test/a", { mainFrame: true }],
    ]);
  });
});
