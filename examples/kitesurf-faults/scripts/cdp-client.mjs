// A small CDP client over Node 24's global WebSocket, for Kitesurf's
// browser endpoint (/devtools/browser) with flat sessions.
//
// Deliberately not Playwright or chaosbringer's crawler: `page.route` would
// add CDP Fetch interception on top of egress (two injectors, and a 5 s
// auto-continue), and the crawler's behaviour on Kitesurf is out of scope.
// This covers only what the scenarios need: open a page, navigate, evaluate,
// read DOM, set Kitesurf's outbound filters, close. Every call has a timeout.

import http from "node:http";

const DEFAULT_TIMEOUT_MS = 60_000;

export async function connect(wsUrl, { timeoutMs = 30_000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connect ${wsUrl}: timeout ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener("open", () => (clearTimeout(t), resolve()), { once: true });
    ws.addEventListener("error", (e) => (clearTimeout(t), reject(new Error(`connect ${wsUrl}: ${e.message ?? "failed"}`))), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  let closed = null;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });
  ws.addEventListener("close", (ev) => {
    closed = { code: ev.code, reason: ev.reason };
    for (const p of pending.values()) p.reject(new Error(`${p.method}: socket closed`));
    pending.clear();
  });

  const send = (method, params = {}, sessionId, timeout = DEFAULT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error(`${method}: socket closed`));
      const id = nextId++;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: timeout ${timeout}ms`));
      }, timeout);
      pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  /** A new page target with a flat session, Page and Runtime enabled. */
  const newPage = async () => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    return { targetId, sessionId };
  };

  const navigate = (sessionId, url, timeout) => send("Page.navigate", { url }, sessionId, timeout);

  /** `{value}` or `{exception}`; a protocol error or timeout rejects. */
  const evaluate = async (sessionId, expression, { awaitPromise = true, timeout } = {}) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId, timeout);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { exception: d.exception?.description ?? d.text ?? "exception" };
    }
    return { value: r.result?.value };
  };

  /** Poll `expression` until `predicate(value)`; returns the value. */
  const waitFor = async (sessionId, expression, predicate, timeout = 30_000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await evaluate(sessionId, expression, { awaitPromise: false, timeout: 10_000 });
        if (predicate(last.value)) return last.value;
      } catch (e) {
        last = { error: String(e) };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`waitFor ${expression}: timeout ${timeout}ms, last ${JSON.stringify(last)}`);
  };

  /** textContent of the first match, through the DOM domain; `null` when absent. */
  const domText = async (sessionId, selector) => {
    const { root } = await send("DOM.getDocument", { depth: -1 }, sessionId);
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector }, sessionId);
    if (!nodeId) return null;
    const { outerHTML } = await send("DOM.getOuterHTML", { nodeId }, sessionId);
    // The fixtures' elements hold plain text, so the inner text is the outer
    // HTML minus its one tag pair.
    return outerHTML.replace(/^<[^>]*>/, "").replace(/<\/[^>]*>$/, "");
  };

  const close = async () => {
    if (closed) return closed;
    const done = new Promise((r) => ws.addEventListener("close", () => r(closed), { once: true }));
    ws.close();
    return Promise.race([done, new Promise((r) => setTimeout(() => r({ timeout: true }), 5_000))]);
  };

  return {
    send,
    newPage,
    navigate,
    evaluate,
    waitFor,
    domText,
    close,
    get closed() {
      return closed;
    },
  };
}

/**
 * Attempt a WebSocket upgrade and report only the status: 101 when accepted,
 * otherwise the refusal (400 / 409). The socket is dropped either way.
 */
export function upgradeStatus(httpUrl, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(httpUrl, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
      timeout,
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => req.destroy(new Error(`upgrade ${httpUrl}: timeout ${timeout}ms`)));
    req.on("error", reject);
    req.end();
  });
}
