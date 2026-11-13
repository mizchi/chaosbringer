/**
 * The "real server" behind the fault session: an origin that exists only
 * inside the host Worker's isolate, at https://shop.invalid.
 *
 * In-isolate rather than a loopback server so the upstream counts are exact
 * (the host counts every call before it gets here) and so the engine's
 * private-network check can stay on: `KITESURF_ALLOW_PRIVATE_NETWORK` is
 * empty, and the page could not reach a 127.0.0.1 server anyway.
 *
 * Two pages run the same checkout load against `/api/cart`:
 * - `/correct/` retries a non-ok response, up to three tries, and renders
 *   `ok:<items>` once one succeeds.
 * - `/broken/` gives up on the first non-ok response and renders `failed`.
 *   It is the page the oracle has to reject.
 * Both write `#result` before `#attempts`, so a reader that waits for
 * `#attempts` sees the final result.
 */

export const ORIGIN = "https://shop.invalid";

const page = (title: string, body: string, script: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

const CART_BODY = `<div id="result">pending</div><div id="attempts"></div>`;

const render = `
  const show = (result, attempts) => {
    document.getElementById('result').textContent = result;
    document.getElementById('attempts').textContent = attempts.join(',');
  };`;

const CORRECT_SCRIPT = `${render}
(async () => {
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('/api/cart');
      attempts.push(r.status);
      if (r.ok) { const j = await r.json(); return show('ok:' + j.items, attempts); }
    } catch (e) { attempts.push('err'); }
  }
  show('failed', attempts);
})();`;

// The bug under test: a 503 is treated as final.
const BROKEN_SCRIPT = `${render}
(async () => {
  try {
    const r = await fetch('/api/cart');
    if (!r.ok) return show('failed', [r.status]);
    const j = await r.json();
    show('ok:' + j.items, [r.status]);
  } catch (e) { show('failed', ['err']); }
})();`;

// A WebSocket from the page goes through the loaded PageScript's
// globalOutbound, not the page fetch shim: the other egress path.
const WS_SCRIPT = `
try {
  const ws = new WebSocket('wss://' + location.host + '/ws');
  ws.onopen = () => ws.send('ping');
  ws.onmessage = (e) => { document.getElementById('ws').textContent = 'msg:' + e.data; ws.close(); };
  ws.onerror = () => { document.getElementById('ws').textContent = 'error'; };
} catch (e) { document.getElementById('ws').textContent = 'throw:' + e.message; }`;

const WORKER_SCRIPT = `
try {
  const w = new Worker('/worker.js');
  w.onmessage = (e) => { document.getElementById('w').textContent = 'msg:' + e.data; };
  w.onerror = (e) => { document.getElementById('w').textContent = 'error:' + (e && e.message); };
} catch (e) { document.getElementById('w').textContent = 'throw:' + e.message; }`;

const WORKER_JS = `fetch('/api/from-worker').then(r => r.text()).then(t => postMessage(t), e => postMessage('err:' + e.message));`;

const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

export function fixture(request: Request): Response {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/correct/":
    case "/again.html":
      return html(page("cart", CART_BODY, CORRECT_SCRIPT));
    case "/broken/":
      return html(page("cart", CART_BODY, BROKEN_SCRIPT));
    case "/ws.html":
      return html(page("ws", `<div id="ws">pending</div>`, WS_SCRIPT));
    case "/worker.html":
      return html(page("worker", `<div id="w">pending</div>`, WORKER_SCRIPT));
    case "/worker.js":
      return new Response(WORKER_JS, { headers: { "content-type": "text/javascript" } });
    case "/ws": {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("need upgrade", { status: 426 });
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      // Reply only to a message: a send before the page's accept surfaced as
      // a page-side error in the spike.
      server.addEventListener("message", (e) => server.send(`echo:${e.data}`));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    case "/api/cart":
      return Response.json({ items: 3 });
    default:
      if (url.pathname.startsWith("/api/")) return Response.json({ path: url.pathname });
      return new Response("not found", { status: 404 });
  }
}
