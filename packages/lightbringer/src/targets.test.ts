import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACH_SETUP_TIMEOUT_MS,
  ChildTargets,
  type CdpEndpoint,
  type ChildTarget,
} from "./targets";

// A fake CDP target tree. The root is the page's session (a CdpEndpoint); a
// child is reached, as with a real browser and `flatten: false`, only through
// `Target.sendMessageToTarget` / `Target.receivedMessageFromTarget` on its
// parent.
type Handler = (method: string, params: any) => unknown;

class FakeTarget {
  readonly log: string[] = [];
  readonly children = new Map<string, FakeTarget>();
  private readonly listeners = new Map<string, Set<(p: any) => void>>();
  /** method → handler; a handler may return a promise to hold the answer */
  handlers = new Map<string, Handler>();
  constructor(readonly name: string) {}

  /** the parent's side: run a command on this target */
  async command(method: string, params: any): Promise<unknown> {
    this.log.push(method);
    if (method === "Target.sendMessageToTarget") {
      const child = this.children.get(params.sessionId);
      if (!child) throw new Error("No session with given id");
      const msg = JSON.parse(params.message);
      void child.command(msg.method, msg.params).then(
        (result) => this.emit("Target.receivedMessageFromTarget", {
          sessionId: params.sessionId,
          message: JSON.stringify({ id: msg.id, result: result ?? {} }),
        }),
        (err: Error) => this.emit("Target.receivedMessageFromTarget", {
          sessionId: params.sessionId,
          message: JSON.stringify({ id: msg.id, error: { message: err.message } }),
        }),
      );
      return {};
    }
    const h = this.handlers.get(method);
    return h ? await h(method, params) : {};
  }

  /** this target emits an event to whoever is attached */
  emit(method: string, params: any): void {
    if (this.parent) {
      this.parent.emit("Target.receivedMessageFromTarget", {
        sessionId: this.sessionId,
        message: JSON.stringify({ method, params }),
      });
      return;
    }
    for (const l of Array.from(this.listeners.get(method) ?? [])) l(params);
  }

  parent?: FakeTarget;
  sessionId = "";

  /** attach `child` under this target, as auto-attach does */
  attachChild(child: FakeTarget, sessionId: string, waiting = true): void {
    child.parent = this;
    child.sessionId = sessionId;
    this.children.set(sessionId, child);
    this.emit("Target.attachedToTarget", {
      sessionId,
      targetInfo: { targetId: `T-${child.name}`, type: "iframe", url: "" },
      waitingForDebugger: waiting,
    });
  }

  detachChild(sessionId: string): void {
    this.children.delete(sessionId);
    this.emit("Target.detachedFromTarget", { sessionId });
  }

  endpoint(): CdpEndpoint {
    return {
      send: (m, p) => this.command(m, p),
      on: (e, l) => {
        let s = this.listeners.get(e);
        if (!s) this.listeners.set(e, (s = new Set()));
        s.add(l);
      },
      off: (e, l) => {
        this.listeners.get(e)?.delete(l);
      },
    };
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ChildTargets", () => {
  it("auto-attaches paused, non-flattened, iframes only", async () => {
    const page = new FakeTarget("page");
    const setAuto = vi.fn();
    page.handlers.set("Target.setAutoAttach", (_m, p) => setAuto(p));
    const tree = new ChildTargets(page.endpoint());
    await tree.subscribe({ attached: () => {} });
    expect(setAuto).toHaveBeenCalledWith({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: "iframe" }],
    });
  });

  it("enables the subscriber's domains before resuming a new target", async () => {
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    let release!: () => void;
    const frame = new FakeTarget("frame");
    frame.handlers.set("Network.enable", () => new Promise<void>((r) => (release = r)));
    const seen: ChildTarget[] = [];
    await tree.subscribe({
      attached: async (child) => {
        seen.push(child);
        await child.send("Network.enable");
      },
    });
    page.attachChild(frame, "S1");
    await flush();
    expect(seen.map((c) => [c.sessionId, c.targetId, c.depth])).toEqual([["S1", "T-frame", 1]]);
    expect(frame.log).toContain("Network.enable");
    expect(frame.log).not.toContain("Runtime.runIfWaitingForDebugger");
    release();
    await flush();
    expect(frame.log.at(-1)).toBe("Runtime.runIfWaitingForDebugger");
    // its own subframes are auto-attached (and held) before it runs
    expect(frame.log.indexOf("Target.setAutoAttach")).toBeLessThan(
      frame.log.indexOf("Runtime.runIfWaitingForDebugger"),
    );
  });

  it("routes a child's events and command results to it", async () => {
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    const frame = new FakeTarget("frame");
    frame.handlers.set("Runtime.evaluate", () => ({ result: { value: 42 } }));
    const events: unknown[] = [];
    let child!: ChildTarget;
    await tree.subscribe({
      attached: (c) => {
        child = c;
        c.on("Network.requestWillBeSent", (p) => events.push(p));
      },
    });
    page.attachChild(frame, "S1");
    await flush();
    frame.emit("Network.requestWillBeSent", { requestId: "1" });
    // another child's message is not delivered to this one
    page.emit("Target.receivedMessageFromTarget", {
      sessionId: "OTHER",
      message: JSON.stringify({ method: "Network.requestWillBeSent", params: { requestId: "x" } }),
    });
    expect(events).toEqual([{ requestId: "1" }]);
    await expect(child.send("Runtime.evaluate", { expression: "1" })).resolves.toEqual({
      result: { value: 42 },
    });
    frame.handlers.set("Boom.fail", () => {
      throw new Error("nope");
    });
    await expect(child.send("Boom.fail")).rejects.toThrow("nope");
  });

  it("attaches nested OOPIFs through their parent frame's target", async () => {
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    const frame = new FakeTarget("frame");
    const nested = new FakeTarget("nested");
    const events: Array<[string, unknown]> = [];
    await tree.subscribe({
      attached: async (c) => {
        c.on("Network.loadingFinished", (p) => events.push([c.sessionId, p]));
        await c.send("Network.enable");
      },
    });
    page.attachChild(frame, "S1");
    await flush();
    frame.attachChild(nested, "S2");
    await flush();
    expect(nested.log).toEqual([
      "Target.setAutoAttach",
      "Network.enable",
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(tree.targets.map((t) => [t.sessionId, t.depth])).toEqual([
      ["S1", 1],
      ["S2", 2],
    ]);
    nested.emit("Network.loadingFinished", { requestId: "n" });
    frame.emit("Network.loadingFinished", { requestId: "f" });
    expect(events).toEqual([
      ["S2", { requestId: "n" }],
      ["S1", { requestId: "f" }],
    ]);
  });

  it("forgets a detached child and its nested ones", async () => {
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    const frame = new FakeTarget("frame");
    const nested = new FakeTarget("nested");
    const detached: string[] = [];
    let child!: ChildTarget;
    await tree.subscribe({
      attached: (c) => {
        if (c.depth === 1) child = c;
      },
      detached: (c) => detached.push(c.sessionId),
    });
    page.attachChild(frame, "S1");
    await flush();
    frame.attachChild(nested, "S2");
    await flush();
    frame.handlers.set("Slow.call", () => new Promise(() => {}));
    const pending = child.send("Slow.call");
    page.detachChild("S1");
    await expect(pending).rejects.toThrow("target detached");
    expect(detached.sort()).toEqual(["S1", "S2"]);
    expect(tree.targets).toEqual([]);
    await expect(child.send("Network.enable")).rejects.toThrow("target detached");
  });

  it("resumes a target whose subscriber never finishes", async () => {
    vi.useFakeTimers();
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    const frame = new FakeTarget("frame");
    await tree.subscribe({ attached: () => new Promise(() => {}) });
    page.attachChild(frame, "S1");
    await vi.advanceTimersByTimeAsync(ATTACH_SETUP_TIMEOUT_MS - 1);
    expect(frame.log).not.toContain("Runtime.runIfWaitingForDebugger");
    await vi.advanceTimersByTimeAsync(2);
    expect(frame.log).toContain("Runtime.runIfWaitingForDebugger");
  });

  it("resumes a target whose subscriber throws", async () => {
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    const frame = new FakeTarget("frame");
    await tree.subscribe({
      attached: () => {
        throw new Error("bug");
      },
    });
    page.attachChild(frame, "S1");
    await flush();
    expect(frame.log).toContain("Runtime.runIfWaitingForDebugger");
  });

  it("replays attached children to a late subscriber, once auto-attach is on", async () => {
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    const frame = new FakeTarget("frame");
    await tree.subscribe({ attached: () => {} });
    page.attachChild(frame, "S1");
    await flush();
    const late: string[] = [];
    await tree.subscribe({ attached: (c) => void late.push(c.sessionId) });
    expect(late).toEqual(["S1"]);
    // one auto-attach per session, however many subscribers
    expect(page.log.filter((m) => m === "Target.setAutoAttach")).toHaveLength(1);
  });

  it("turns auto-attach off and leaves every child when the last subscriber goes", async () => {
    const page = new FakeTarget("page");
    const autoAttach: boolean[] = [];
    page.handlers.set("Target.setAutoAttach", (_m, p) => void autoAttach.push(p.autoAttach));
    const tree = new ChildTargets(page.endpoint());
    const frame = new FakeTarget("frame");
    const unsubA = await tree.subscribe({ attached: () => {} });
    const unsubB = await tree.subscribe({ attached: () => {} });
    page.attachChild(frame, "S1");
    await flush();
    await unsubA();
    expect(autoAttach).toEqual([true]);
    await unsubB();
    expect(autoAttach).toEqual([true, false]);
    expect(page.log).toContain("Target.detachFromTarget");
    expect(tree.targets).toEqual([]);
    expect(page.listenerCount()).toBe(0);
    // a second call is a no-op
    await unsubB();
    expect(autoAttach).toEqual([true, false]);
  });

  it("lets go of a target attached while shutting down", async () => {
    const page = new FakeTarget("page");
    let release!: () => void;
    const tree = new ChildTargets(page.endpoint());
    const unsub = await tree.subscribe({ attached: () => {} });
    page.handlers.set("Target.setAutoAttach", () => new Promise<void>((r) => (release = r)));
    const stopping = unsub();
    await flush();
    const late = new FakeTarget("late");
    page.attachChild(late, "S9");
    await flush();
    expect(late.log).toEqual(["Runtime.runIfWaitingForDebugger"]);
    expect(page.log.filter((m) => m === "Target.detachFromTarget")).toHaveLength(1);
    release();
    await stopping;
  });

  it("can be subscribed to again after shutting down", async () => {
    const page = new FakeTarget("page");
    const tree = new ChildTargets(page.endpoint());
    const unsub = await tree.subscribe({ attached: () => {} });
    await unsub();
    const seen: string[] = [];
    await tree.subscribe({ attached: (c) => void seen.push(c.sessionId) });
    page.attachChild(new FakeTarget("frame"), "S1");
    await flush();
    expect(seen).toEqual(["S1"]);
    expect(page.log.filter((m) => m === "Target.setAutoAttach")).toHaveLength(3);
  });

  it("survives a session that refuses auto-attach", async () => {
    const page = new FakeTarget("page");
    page.handlers.set("Target.setAutoAttach", () => {
      throw new Error("Target closed");
    });
    const tree = new ChildTargets(page.endpoint());
    const unsub = await tree.subscribe({ attached: () => {} });
    await unsub();
  });
});
