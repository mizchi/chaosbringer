/**
 * Tiny static site for the Playwright Test example. Three pages:
 * `/`, `/about`, and `/broken-link` (404). The chaos fixture crawls all
 * three; the deadLinks invariant catches `/broken-link`.
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
};

const server = createServer((req, res) => {
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
