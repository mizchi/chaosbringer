/**
 * Tiny fixture HTTP server that serves pages covering the main chaos
 * scenarios chaosbringer is designed to surface. Keep this deliberately
 * small and readable — it's the dogfood target, not a real app.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface Route {
  body: string;
  status?: number;
  contentType?: string;
}

const pages: Record<string, Route> = {
  "/": {
    body: html({
      title: "Home",
      nav: true,
      body: `
        <h1>Fixture Home</h1>
        <p>Landing page with a mix of good links, bad links, and interactive elements.</p>
        <ul>
          <li><a href="/about">About (good)</a></li>
          <li><a href="/broken-link">Broken link (404)</a></li>
          <li><a href="/console-error">Page with console.error</a></li>
          <li><a href="/js-exception">Page with JS exception</a></li>
          <li><a href="/unhandled-rejection">Page with unhandled promise rejection</a></li>
          <li><a href="/network-error">Page with network error</a></li>
          <li><a href="/form">Form page</a></li>
          <li><a href="/api-consumer">API consumer (fetches /api/data)</a></li>
          <li><a href="/spa/items/42">SPA route</a></li>
          <li><a href="https://example.com/">External (should be blocked)</a></li>
        </ul>
        <button type="button" onclick="window.alert('clicked')">A harmless button</button>
      `,
    }),
  },

  "/about": {
    body: html({
      title: "About",
      nav: true,
      body: `<h1>About</h1><p>Nothing to see here.</p><a href="/">back</a>`,
    }),
  },

  "/console-error": {
    body: html({
      title: "Console error",
      nav: true,
      body: `
        <h1>Console error</h1>
        <p>Logs a console.error on load.</p>
        <script>console.error("fixture: intentional console error");</script>
        <a href="/">back</a>
      `,
    }),
  },

  "/js-exception": {
    body: html({
      title: "JS exception",
      nav: true,
      body: `
        <h1>JS exception</h1>
        <script>throw new Error("fixture: boom");</script>
        <a href="/">back</a>
      `,
    }),
  },

  "/unhandled-rejection": {
    body: html({
      title: "Unhandled rejection",
      nav: true,
      body: `
        <h1>Unhandled rejection</h1>
        <script>Promise.reject(new Error("fixture: unhandled"));</script>
        <a href="/">back</a>
      `,
    }),
  },

  "/network-error": {
    body: html({
      title: "Network error",
      nav: true,
      body: `
        <h1>Network error</h1>
        <p>References a missing asset.</p>
        <img src="/does-not-exist.png" alt="broken">
        <a href="/">back</a>
      `,
    }),
  },

  "/form": {
    body: html({
      title: "Form",
      nav: true,
      body: `
        <h1>Form</h1>
        <form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted'">
          <label>Name <input type="text" name="name" required></label>
          <label>Email <input type="email" name="email" required></label>
          <button type="submit">Submit</button>
        </form>
        <p id="out"></p>
        <a href="/">back</a>
      `,
    }),
  },

  // Page that fetches /api/data on load; if the API fails the DOM reflects it.
  // Useful for exercising fault injection + invariant assertions together.
  "/api-consumer": {
    body: html({
      title: "API Consumer",
      nav: true,
      body: `
        <h1>API Consumer</h1>
        <p id="status">loading…</p>
        <p id="value"></p>
        <script>
          fetch("/api/data")
            .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((data) => {
              document.getElementById("status").textContent = "ok";
              document.getElementById("value").textContent = JSON.stringify(data);
            })
            .catch((err) => {
              document.getElementById("status").textContent = "error: " + err.message;
            });
        </script>
        <a href="/">back</a>
      `,
    }),
  },

  "/api/data": {
    body: JSON.stringify({ ok: true, items: [1, 2, 3] }),
    contentType: "application/json; charset=utf-8",
  },

  // SPA-like route that renders a shell and reports "not found" in the DOM
  "/spa/items/42": {
    body: html({
      title: "SPA item",
      nav: true,
      body: `
        <h1>SPA Item</h1>
        <div id="app">Loading…</div>
        <script>
          setTimeout(() => {
            document.getElementById('app').textContent = 'Item 42';
          }, 20);
        </script>
        <a href="/">back</a>
      `,
    }),
  },
};

function html({ title, body, nav }: { title: string; body: string; nav?: boolean }): string {
  const header = nav
    ? `<nav><a href="/">Home</a> | <a href="/about">About</a> | <a href="/form">Form</a></nav>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  ${header}
  <main>${body}</main>
</body></html>`;
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url || "/").split("?")[0]!;
  const route = pages[url];
  if (route) {
    res.writeHead(route.status ?? 200, {
      "content-type": route.contentType ?? "text/html; charset=utf-8",
    });
    res.end(route.body);
    return;
  }
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end(html({ title: "Not Found", body: `<h1>404</h1><p>${url}</p>` }));
}

export function startFixtureServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind fixture server"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Run standalone: `pnpm tsx fixtures/site/server.ts`
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT || 4455);
  startFixtureServer(port).then(({ url }) => {
    console.log(`Fixture server listening on ${url}`);
    console.log("Routes:", Object.keys(pages).join(", "));
  });
}
