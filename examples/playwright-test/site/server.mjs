/**
 * Tiny static site for the Playwright Test example. Three pages:
 * `/`, `/about`, and `/broken-link` (404). The chaos fixture crawls all
 * three; the deadLinks invariant catches `/broken-link`.
 *
 * Plus `/stock`, which nothing links to: it renders what `/api/stock`
 * answers, and a fallback when that request fails — the page the fault
 * test breaks the API under.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3300);

const PAGES = {
  "/": `<!doctype html>
<title>Home</title>
<h1>Home</h1>
<ul>
  <li><a href="/about">About</a></li>
  <li><a href="/broken-link">Broken</a></li>
</ul>`,
  "/about": `<!doctype html>
<title>About</title>
<h1>About</h1>
<p>The about page.</p>
<p><a href="/">home</a></p>`,
  "/stock": `<!doctype html>
<title>Stock</title>
<h1>Stock</h1>
<p role="status">Loading…</p>
<script>
  fetch("/api/stock")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((stock) => \`\${stock.count} in stock\`, () => "Stock unavailable")
    .then((text) => {
      document.querySelector("[role=status]").textContent = text;
    });
</script>`,
};

const server = createServer((req, res) => {
  if (req.url === "/api/stock") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count: 3 }));
    return;
  }
  // Browsers auto-request /favicon.ico; chaosbringer treats 404s on those
  // as `requestfailed` errors. Returning 204 No Content keeps the home-
  // page test free of incidental noise.
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const body = PAGES[req.url ?? "/"];
  if (!body) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`fixture site listening on http://localhost:${PORT}`);
});
