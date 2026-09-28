// ---------------------------------------------------------------------------
// Child targets of a page: out-of-process iframes (OOPIFs).
//
// Under site isolation (headed Chromium, a real Chrome over CDP,
// `--site-per-process`) a cross-site iframe is its own CDP target. The page's
// session sees only the iframe's document request being sent; the document's
// body and every request the iframe makes are reported on the iframe's target.
// This module attaches to those targets from the page's own session so the
// measurement layers can enable domains on them.
//
// Mechanism: `Target.setAutoAttach` on the page session with
// `waitForDebuggerOnStart: true` and `flatten: false`, recursively on each child
// (a nested OOPIF is auto-attached by its parent frame's target, not the page's).
//   - waitForDebuggerOnStart holds a new target paused until every client that
//     asked for it resumes it, so domains are enabled before the frame's first
//     request: nothing is missed, unlike attaching after `framenavigated`.
//     Playwright auto-attaches with the same flag on its own sessions; the
//     target runs once both have sent `Runtime.runIfWaitingForDebugger`.
//   - flatten: false because Playwright's public CDPSession cannot reach a
//     flattened child session: its connection drops messages for a sessionId it
//     did not create itself. Non-flattened, every child message travels inside
//     `Target.receivedMessageFromTarget` on the parent session, and commands go
//     out through `Target.sendMessageToTarget`, both plain events / commands of
//     the page's session.
// Because a paused target waits for this client too, every attached target is
// resumed whatever its subscribers do (a failed or slow enable is bounded by
// ATTACH_SETUP_TIMEOUT_MS), and auto-attach is turned off once nothing
// subscribes any more.
//
// Only iframes are auto-attached. Workers are left out: a dedicated worker's
// requests are not on the page's session either, but reading them from its
// target proved unreliable under site isolation (a top-level worker's fetch
// did not show up on its own target), so worker traffic stays uncounted.
// ---------------------------------------------------------------------------
import type { CDPSession } from "playwright";

/** The CDP surface this module and its subscribers use; a child target implements it too. */
export interface CdpEndpoint {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: any) => void): unknown;
  off(event: string, listener: (params: any) => void): unknown;
}

/** An attached child target (an OOPIF), as a session its subscribers can talk to. */
export interface ChildTarget extends CdpEndpoint {
  /** the CDP sessionId of this client's attachment; unique across the browser */
  readonly sessionId: string;
  readonly targetId: string;
  readonly type: string;
  /** 1 for a child of the page, 2 for a nested OOPIF inside it, ... */
  readonly depth: number;
}

export interface ChildTargetSubscriber {
  /**
   * A child target is attached. Awaited (bounded) before a new target is
   * resumed, so domains enabled here see its first request. Also called for
   * the children already attached when the subscriber joins.
   */
  attached(child: ChildTarget): Promise<void> | void;
  /** The child went away (iframe removed, navigated back in-process, page closed). */
  detached?(child: ChildTarget): void;
}

/**
 * How long a new target's subscribers may take before it is resumed anyway.
 * A target that is never resumed never loads, which would hang the frame.
 */
export const ATTACH_SETUP_TIMEOUT_MS = 2_000;

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: false,
  filter: [{ type: "iframe" }],
};

interface AttachedEvent {
  sessionId: string;
  targetInfo: { targetId: string; type: string };
  waitingForDebugger?: boolean;
}

/** Wrap a Playwright CDPSession in the loosely typed endpoint shape. */
export function cdpEndpoint(client: CDPSession): CdpEndpoint {
  const c = client as unknown as CdpEndpoint;
  return {
    send: (method, params) => c.send(method, params),
    on: (event, listener) => c.on(event, listener),
    off: (event, listener) => c.off(event, listener),
  };
}

class Child implements ChildTarget {
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  closed = false;
  /** children auto-attached by this target (nested OOPIFs) */
  readonly children = new Map<string, Child>();

  constructor(
    private readonly parent: CdpEndpoint,
    private readonly nextId: () => number,
    readonly sessionId: string,
    readonly targetId: string,
    readonly type: string,
    readonly depth: number,
  ) {}

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`target detached: ${method}`));
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.parent
        .send("Target.sendMessageToTarget", {
          sessionId: this.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((err: unknown) => {
          if (!this.pending.delete(id)) return;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  on(event: string, listener: (params: any) => void): void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
  }

  off(event: string, listener: (params: any) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** One message from this target (a command response or an event). */
  deliver(raw: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const l of Array.from(this.listeners.get(msg.method) ?? [])) {
      try {
        l(msg.params);
      } catch {
        /* a listener's bug must not break routing for the others */
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("target detached"));
    this.pending.clear();
  }
}

/**
 * The OOPIF tree under one page session. One per session (see
 * {@link childTargets}): auto-attach is a per-session setting, so two trees on
 * one session would each miss what the other attached.
 */
export class ChildTargets {
  private readonly subscribers = new Set<ChildTargetSubscriber>();
  /** every attached target, nested ones included, by sessionId */
  private readonly all = new Map<string, Child>();
  private readonly top = new Map<string, Child>();
  private started: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly unhook: Array<() => void> = [];
  private id = 0;

  constructor(private readonly root: CdpEndpoint) {}

  /** Attached targets, nested ones included. */
  get targets(): ChildTarget[] {
    return Array.from(this.all.values());
  }

  /**
   * Add a subscriber, starting auto-attach on first use. Resolves once
   * auto-attach is on and the subscriber has seen the children already
   * attached. The returned function removes the subscriber; the last one out
   * turns auto-attach off and detaches from every child.
   */
  async subscribe(sub: ChildTargetSubscriber): Promise<() => Promise<void>> {
    // A tree that is shutting down is finished first; a new subscriber then
    // starts it again.
    if (this.stopping) await this.stopping;
    this.subscribers.add(sub);
    if (!this.started) {
      this.started = this.watch(this.root, this.top, 1).catch(() => {
        // The page's session refused auto-attach (a closed page, a
        // non-Chromium target): nothing to attach to.
      });
    }
    await this.started;
    for (const child of Array.from(this.all.values())) {
      await bounded(Promise.resolve().then(() => sub.attached(child)));
    }
    let removed = false;
    return async () => {
      if (removed) return;
      removed = true;
      this.subscribers.delete(sub);
      if (this.subscribers.size === 0) await this.stop();
    };
  }

  /** Auto-attach under `endpoint`, routing its children's messages. */
  private async watch(
    endpoint: CdpEndpoint,
    into: Map<string, Child>,
    depth: number,
  ): Promise<void> {
    const onAttached = (e: AttachedEvent) => {
      void this.attach(endpoint, into, depth, e);
    };
    const onDetached = (e: { sessionId: string }) => {
      const child = into.get(e.sessionId);
      if (child) this.drop(child, into);
    };
    const onMessage = (e: { sessionId: string; message: string }) => {
      into.get(e.sessionId)?.deliver(e.message);
    };
    endpoint.on("Target.attachedToTarget", onAttached);
    endpoint.on("Target.detachedFromTarget", onDetached);
    endpoint.on("Target.receivedMessageFromTarget", onMessage);
    if (endpoint === this.root) {
      this.unhook.push(() => {
        endpoint.off("Target.attachedToTarget", onAttached);
        endpoint.off("Target.detachedFromTarget", onDetached);
        endpoint.off("Target.receivedMessageFromTarget", onMessage);
      });
    }
    await endpoint.send("Target.setAutoAttach", AUTO_ATTACH);
  }

  private async attach(
    parent: CdpEndpoint,
    into: Map<string, Child>,
    depth: number,
    e: AttachedEvent,
  ): Promise<void> {
    const child = new Child(
      parent,
      () => ++this.id,
      e.sessionId,
      e.targetInfo.targetId,
      e.targetInfo.type,
      depth,
    );
    into.set(child.sessionId, child);
    if (this.stopping || this.subscribers.size === 0) {
      // Attached while shutting down: let it run and let go of it.
      await this.release(parent, child);
      into.delete(child.sessionId);
      return;
    }
    this.all.set(child.sessionId, child);
    try {
      await bounded(
        (async () => {
          // Nested OOPIFs first, so the child's own subframes are held too.
          await this.watch(child, child.children, depth + 1).catch(() => {});
          for (const sub of Array.from(this.subscribers)) {
            await Promise.resolve()
              .then(() => sub.attached(child))
              .catch(() => {});
          }
        })(),
      );
    } finally {
      // Always resume: a target waiting for this client never loads otherwise.
      child.send("Runtime.runIfWaitingForDebugger").catch(() => {});
    }
  }

  /** A child is gone: forget it and everything nested under it. */
  private drop(child: Child, from: Map<string, Child>): void {
    from.delete(child.sessionId);
    for (const nested of Array.from(child.children.values())) this.drop(nested, child.children);
    if (!this.all.delete(child.sessionId)) return;
    child.close();
    for (const sub of Array.from(this.subscribers)) {
      try {
        sub.detached?.(child);
      } catch {
        /* ignore */
      }
    }
  }

  /** Resume and detach one child (best effort). */
  private async release(parent: CdpEndpoint, child: Child): Promise<void> {
    await child.send("Runtime.runIfWaitingForDebugger").catch(() => {});
    child.close();
    await parent
      .send("Target.detachFromTarget", { sessionId: child.sessionId })
      .catch(() => {});
  }

  private stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        if (this.started) await this.started;
        // Off first, so nothing new is attached (and held) behind our back;
        // then let go of what is attached. Nested children go with their parent.
        await this.root
          .send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: false })
          .catch(() => {});
        for (const child of Array.from(this.top.values())) {
          await this.release(this.root, child);
          this.drop(child, this.top);
        }
        for (const off of this.unhook.splice(0)) off();
        this.started = null;
      })().finally(() => {
        this.stopping = null;
      });
    }
    return this.stopping;
  }
}

function bounded(p: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ATTACH_SETUP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

const trees = new WeakMap<object, ChildTargets>();

/**
 * The shared OOPIF tree of a page session (created on first use). Every
 * lightbringer layer that needs a domain on child targets subscribes to the
 * same tree.
 */
export function childTargets(client: CDPSession | CdpEndpoint): ChildTargets {
  let tree = trees.get(client);
  if (!tree) {
    const endpoint =
      typeof (client as CDPSession).detach === "function"
        ? cdpEndpoint(client as CDPSession)
        : (client as CdpEndpoint);
    tree = new ChildTargets(endpoint);
    trees.set(client, tree);
  }
  return tree;
}
