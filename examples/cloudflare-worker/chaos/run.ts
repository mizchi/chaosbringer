/**
 * chaosbringer driver. Run `pnpm dev` (worker on :8787) in one terminal,
 * then `pnpm chaos` in another.
 *
 * Demonstrates:
 *   - Network-layer faults via chaosbringer's `faults.*` (intercepted
 *     before the request reaches the server).
 *   - Server-side faults via `@mizchi/server-faults` running in the worker
 *     (synthetic 5xx / latency, with `x-chaos-fault-*` response headers).
 *   - Remote-mode ingestion: `server: { mode: "remote" }` parses those
 *     headers and surfaces events on `report.serverFaults`.
 *   - Setup hook with seed retries and the chaos-bypass header.
 */

import { chaos, faults, type Invariant } from "chaosbringer";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8787";
const SEED_TODOS = Number(process.env.SEED_TODOS ?? "5");

const invariants: Invariant[] = [
  {
    name: "no-loading-stuck",
    when: "afterActions",
    async check({ page }) {
      const t = (await page.locator("body").textContent()) ?? "";
      return !/loading\.\.\./i.test(t) || "still showing loading...";
    },
  },
  {
    name: "has-h1",
    when: "afterLoad",
    async check({ page }) {
      return (await page.locator("h1").count()) > 0 || "no <h1>";
    },
  },
];

async function main() {
  const { passed, report } = await chaos({
    baseUrl: BASE_URL,
    seed: Number(process.env.SEED ?? "42"),
    maxPages: Number(process.env.MAX_PAGES ?? "20"),
    strict: false,
    traceparent: true,
    faultInjection: [
      // Network-layer faults — intercepted by Playwright BEFORE the worker is called.
      // These produce no `x-chaos-fault-*` headers because the worker is never reached.
      faults.status(500, { urlPattern: /\/api\/todos$/, methods: ["GET"], probability: 0.2 }),
      faults.delay(2000, { urlPattern: /\/api\/todos/, probability: 0.1 }),
    ],
    // Surface server-side fault events emitted by @mizchi/server-faults
    // running in the worker. The default header prefix is `x-chaos-fault`.
    server: { mode: "remote" },
    invariants,
    setup: async ({ page, baseUrl }) => {
      // Seed must succeed even when CHAOS_5XX_RATE > 0. The bypass header
      // makes the seed path immune to the worker's chaos middleware.
      // (See docs/recipes/seeding-data.md.)
      for (let i = 0; i < SEED_TODOS; i++) {
        const r = await page.request.post(`${baseUrl}/api/todos`, {
          headers: { "x-chaos-bypass": "1" },
          data: { title: `seed-${i}` },
        });
        if (!r.ok()) throw new Error(`seed POST failed: ${r.status()}`);
      }
      console.log(`seeded ${SEED_TODOS} todos`);
    },
  });

  console.log(report.reproCommand);
  console.log(`pages=${report.pagesVisited} errors=${report.totalErrors}`);

  const sf = report.serverFaults ?? [];
  if (sf.length > 0) {
    console.log(`server-side fault events: ${sf.length}`);
    const byKind = sf.reduce<Record<string, number>>((acc, e) => {
      acc[e.attrs.kind] = (acc[e.attrs.kind] ?? 0) + 1;
      return acc;
    }, {});
    for (const [kind, n] of Object.entries(byKind)) console.log(`  ${kind}: ${n}`);
  } else {
    console.log("server-side fault events: 0 (set CHAOS_5XX_RATE / CHAOS_LATENCY_RATE on the worker to see some)");
  }

  const pagesWithServerFaults = report.pages.filter((p) => p.serverFaultEvents && p.serverFaultEvents.length > 0);
  const actionsWithServerFaults = report.actions.filter((a) => a.serverFaultEvents && a.serverFaultEvents.length > 0);
  console.log(`pages with server faults: ${pagesWithServerFaults.length}`);
  console.log(`actions with server faults: ${actionsWithServerFaults.length}`);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
