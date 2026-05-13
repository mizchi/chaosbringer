/**
 * scenarioLoad + chaos demo.
 *
 * Boots a tiny in-process HTTP server (so the example needs no separate
 * `dev` terminal), then runs 5 workers looping a `browse → cart →
 * checkout` journey while 10% of `/api/*` responses are forced to 500.
 *
 * Run: `pnpm start` (from this directory).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  defineScenario,
  faults,
  formatLoadReport,
  scenarioLoad,
} from "chaosbringer";

// -------- tiny demo app --------

const indexHtml = `<!doctype html>
<html><head><title>Shop</title></head>
<body>
  <h1>Demo Shop</h1>
  <button id="add" data-test="add-to-cart">Add</button>
  <button id="checkout" data-test="checkout">Checkout</button>
  <div id="cart" data-test="cart-count">0</div>
  <div id="error" style="display:none" data-test="error">Something went wrong</div>
  <script>
    const cartEl = document.getElementById('cart');
    const errEl = document.getElementById('error');
    let count = 0;
    document.getElementById('add').addEventListener('click', async () => {
      const r = await fetch('/api/cart/add', { method: 'POST' });
      if (!r.ok) { errEl.style.display = 'block'; return; }
      count++;
      cartEl.textContent = String(count);
    });
    document.getElementById('checkout').addEventListener('click', async () => {
      const r = await fetch('/api/checkout', { method: 'POST' });
      if (!r.ok) { errEl.style.display = 'block'; return; }
      document.title = 'thanks';
    });
  </script>
</body></html>`;

function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Simulated per-request latency so the latency rollup is non-trivial.
      const jitter = 10 + Math.floor(Math.random() * 60);
      setTimeout(() => {
        if (req.url === "/" && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(indexHtml);
        } else if (req.url?.startsWith("/api/") && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      }, jitter);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// -------- scenario --------

const shop = defineScenario({
  name: "shop",
  thinkTime: { minMs: 200, maxMs: 600 },
  steps: [
    {
      name: "open",
      run: async ({ page, baseUrl }) => {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      },
    },
    {
      name: "add-to-cart",
      run: async ({ page }) => {
        await page.click('[data-test="add-to-cart"]');
        // Wait briefly so the fetch completes — failures still bubble up
        // as `data-test="error"` becoming visible.
        await page.waitForTimeout(50);
      },
    },
    {
      name: "checkout",
      run: async ({ page }) => {
        await page.click('[data-test="checkout"]');
        await page.waitForTimeout(50);
      },
    },
  ],
});

// -------- main --------

async function main() {
  const server = await startServer();
  console.log(`Demo server: ${server.url}`);
  try {
    const { report, faultStats } = await scenarioLoad({
      baseUrl: server.url,
      duration: "8s",
      rampUp: "1s",
      timelineBucketMs: 500,
      scenarios: [{ scenario: shop, workers: 5 }],
      faultInjection: [
        // 10% of API calls fail with a 500. The invariant below should
        // catch the "error toast visible" recovery state.
        faults.status(500, { urlPattern: "/api/", probability: 0.1, name: "api-500" }),
      ],
      invariants: [
        {
          name: "error-toast-not-stuck",
          async check({ page }) {
            const visible = await page.locator('[data-test="error"]').isVisible();
            return !visible || `error toast visible at ${page.url()}`;
          },
        },
      ],
    });

    console.log("\n" + formatLoadReport(report));
    console.log("\nFault rules:");
    for (const f of faultStats) {
      console.log(`  ${f.rule}: matched=${f.matched}  injected=${f.injected}`);
    }

    // Non-zero exit if no iterations completed — useful as a CI signal.
    if (report.totals.iterations === 0) process.exit(1);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
