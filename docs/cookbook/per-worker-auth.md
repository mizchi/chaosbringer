# Multiple per-worker logged-in identities

`scenarioLoad` runs N workers in parallel, each in its own Playwright
`BrowserContext`. For anything past a logged-out smoke test you want each
worker to be a different *real* user — same-account workers serialise on
backend locks (cart writes, optimistic concurrency) and you end up
load-testing your retry policy, not your app.

## Generate storage states once, reuse for the run

```ts
// scripts/seed-sessions.ts — run this once, commit the JSON files (or .gitignore them).
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const BASE = "http://localhost:3000";
const USERS = [
  { email: "alice@example.com", pw: "alice-pw" },
  { email: "bob@example.com",   pw: "bob-pw"   },
  { email: "carol@example.com", pw: "carol-pw" },
];

const browser = await chromium.launch();
for (let i = 0; i < USERS.length; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill("[name=email]",    USERS[i].email);
  await page.fill("[name=password]", USERS[i].pw);
  await page.click("[type=submit]");
  await page.waitForURL(/\/dashboard/);
  await ctx.storageState({ path: `./fixtures/storage/user-${i}.json` });
  await ctx.close();
}
await browser.close();
```

## Hand the storage states to the load run

```ts
import { defineScenario, scenarioLoad } from "chaosbringer";

const dashboard = defineScenario({
  name: "dashboard",
  steps: [
    { name: "open", run: async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/dashboard`);
      await page.waitForSelector("[data-test=user-greeting]");
    }},
  ],
});

await scenarioLoad({
  baseUrl: "http://localhost:3000",
  duration: "2m",
  scenarios: [
    {
      scenario: dashboard,
      workers: 3,                                    // must match the number of sessions
      storageState: (i) => `./fixtures/storage/user-${i}.json`,
    },
  ],
});
```

## Reset between iterations

If your scenario mutates server-side per-user state (cart, drafts) and you
want each iteration to start clean *without* re-logging-in, clear cookies
locally in `beforeIteration` and re-seed via API:

```ts
const checkout = defineScenario({
  name: "checkout",
  beforeIteration: async ({ page }) => {
    // Drop transient client state, keep storage (login).
    await page.context().clearCookies({ name: "cart_id" });
  },
  steps: [/* ... */],
});
```

## Gotchas

- **Workers count must be ≤ session count** if you do `storageState: (i) => ...`.
  Past the last session the factory returns `undefined` and that worker runs
  logged-out — probably not what you want. Either guard with
  `i < USERS.length` or cycle (`USERS[i % USERS.length]`).
- **Sessions expire.** Re-seed at the start of every CI run; don't rely on
  storage files older than a session lifetime.
- A single string `storageState: "./session.json"` is fine for "every worker
  is the same user" smoke tests.

## Related

- Feature doc: [`docs/recipes/scenario-load.md`](../recipes/scenario-load.md)
- Seeding backend state (different concern, before the run): [`docs/recipes/seeding-data.md`](../recipes/seeding-data.md)
