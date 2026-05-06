# Seeding backend state before a chaos run

A chaos run that lands on an empty app discovers nothing — no list rows to click, no detail pages to navigate into, no forms with valid IDs. The crawler will exit clean while exercising 10% of the actual UI. You need seed data before the run starts.

This recipe covers two patterns and one gotcha.

## When you need this

- The crawler sees `<h1>No items yet</h1>` instead of a populated list.
- All your "interesting" pages are detail pages keyed by IDs that don't exist yet.
- Your invariants assume some baseline state ("the dashboard always shows ≥1 chart").

## Pattern A — `chaos({ setup })` hook

`chaosbringer` exposes a `setup` hook that fires **after** the crawler is constructed (so it sees option-validation errors first) but **before** any chaos action runs:

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:8787",
  seed: 42,
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\/todos$/, probability: 0.3 }),
  ],
  setup: async ({ page, baseUrl }) => {
    // page is a one-shot Playwright page in a disposable browser context.
    // It is closed before the crawler starts — its state does NOT carry
    // into the crawl. Mutate the server (REST), or save storageState to
    // disk and feed it to `options.storageState`.
    for (let i = 0; i < 5; i++) {
      const r = await page.request.post(`${baseUrl}/api/todos`, {
        data: { title: `seed-${i}` },
      });
      if (!r.ok()) throw new Error(`seed POST failed: ${r.status()}`);
    }
  },
});
```

The hook receives a fresh disposable Playwright context. Its `page.request` is a Web-standard request client (no browser navigation happens), so REST seeding is one line per row.

## Pattern B — out-of-process seeding

If your seeding logic is its own script (or your seed source is a fixture file you want to ship alongside the test), do it before calling `chaos()`:

```ts
import { execSync } from "node:child_process";
import { chaos } from "chaosbringer";

execSync("./scripts/seed.sh", { stdio: "inherit" });

await chaos({ baseUrl: "http://localhost:8787", /* … */ });
```

This skips the disposable browser context entirely. Use it when:
- Seed logic is non-trivial and already has its own tests.
- You're sharing seed data between chaos runs and other tests.
- The seed script is the same one CI uses to set up integration tests.

The trade-off vs Pattern A: you lose `page.request`'s automatic cookie / CSRF handling. For unauthenticated REST endpoints this is a non-issue; for sessioned endpoints, prefer Pattern A.

## The gotcha — seed `POST`s eaten by chaos middleware

If your **server** is running with `@mizchi/server-faults` (or any other chaos middleware that rolls a per-request dice), the seed `POST`s themselves are subject to the fault raffle. With `status5xxRate: 0.3` and 5 seed rows, the probability that *all five* succeed is `0.7^5 ≈ 0.17` — your seed step fails ~83% of the time.

Two ways out:

### Option 1 (recommended): bypass the chaos middleware on the seed path

`@mizchi/server-faults` ships a `bypassHeader` option. Configure the server with it:

```ts
import { honoMiddleware } from "@mizchi/server-faults/hono";

app.use("*", honoMiddleware({
  status5xxRate: Number(process.env.CHAOS_5XX_RATE ?? 0),
  bypassHeader: "x-chaos-bypass",
}));
```

Then send the bypass header from your seed call:

```ts
setup: async ({ page, baseUrl }) => {
  for (let i = 0; i < 5; i++) {
    const r = await page.request.post(`${baseUrl}/api/todos`, {
      headers: { "x-chaos-bypass": "1" },
      data: { title: `seed-${i}` },
    });
    if (!r.ok()) throw new Error(`seed POST failed: ${r.status()}`);
  }
},
```

Now the seed path is unconditionally exempt from the dice roll. The crawl traffic is not.

### Option 2: retry until each row lands

If you can't change the server (third-party chaos middleware, or a chaos layer outside your control), retry per row. The math still works in your favour: 10 attempts × 0.3 fail rate ≈ 0.3¹⁰ ≈ 0.0006% per-row failure.

```ts
setup: async ({ page, baseUrl }) => {
  for (let i = 0; i < 5; i++) {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await page.request.post(`${baseUrl}/api/todos`, {
        data: { title: `seed-${i}` },
      });
      if (r.ok()) {
        lastStatus = 0;
        break;
      }
      lastStatus = r.status();
    }
    if (lastStatus !== 0) {
      throw new Error(`seed POST failed after 10 retries: ${lastStatus}`);
    }
  }
},
```

This is what `otel-chaos-lab` does — it can't change the worker because the worker IS what's being tested.

## Common invariants that depend on seed state

If you seed `N` rows, codify the invariant that they actually arrived:

```ts
import { chaos, type Invariant } from "chaosbringer";

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

await chaos({ baseUrl: "...", invariants, setup: /* … */ });
```

The `no-loading-stuck` invariant in particular catches the failure mode where a fault response (5xx / abort) leaves a SPA stuck in its loading skeleton — which is invisible to a navigation-status-only check.

## Related

- `chaos({ setup })` API: see `ChaosRunOptions.setup` in [`packages/chaosbringer/README.md`](../../packages/chaosbringer/README.md#pre-run-setup-hook).
- `bypassHeader` option: see [`packages/server-faults/README.md`](../../packages/server-faults/README.md).
- Reproducible seeds + chaos seeds: pass the same `seed` to both `chaos()` and (if applicable) the server-side chaos middleware. See the `seed` section of `packages/chaosbringer/README.md`.
