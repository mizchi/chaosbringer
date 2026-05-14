# Recipe composition + delta-debugged regressions

Two related additions that round out the recipe layer:

1. **`requires` actually chains.** A recipe that declares
   `requires: ["auth/login"]` now triggers `auth/login` to run first
   whenever it gets replayed. The runner topologically sorts the
   dependency graph, dedupes diamonds, and skips anything that
   already ran in this session.
2. **`investigate({ minimize: true })`** runs delta-debugging on the
   captured reproduction trace before committing the regression
   recipe. A 15-step AI trajectory typically shrinks to 3–5 steps,
   matching what a human bug reporter would write.

## Why `requires` chaining matters

Before this change, declaring `requires: ["auth/login"]` was metadata
only — the runner did nothing with it, and the dependent recipe had
to assume a logged-in state was set up out-of-band. That breaks
fresh `BrowserContext`s (the default for every chaosbringer worker)
and makes the library brittle.

After the change:

```ts
import { RecipeStore, recipeDriver, compositeDriver } from "chaosbringer";

const store = new RecipeStore();
// auth/login: clean → logged-in
store.upsert({
  name: "auth/login",
  steps: [
    { kind: "navigate", url: "http://localhost:3000/login" },
    { kind: "fill", selector: "[name=email]", value: "test@example.com" },
    { kind: "fill", selector: "[name=password]", value: "secret" },
    { kind: "click", selector: "[type=submit]",
      expectAfter: { urlContains: "/dashboard" } },
  ],
  // ... preconditions / status / etc.
});

// shop/checkout: assumes logged-in
store.upsert({
  name: "shop/checkout",
  requires: ["auth/login"],
  preconditions: [{ urlPattern: "/dashboard" }],
  steps: [/* navigate to cart, click checkout, ... */],
  // ...
});

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver({
    drivers: [recipeDriver({ store })], // chains automatically
  }),
});
```

When `recipeDriver` matches `shop/checkout`:
1. Resolves the full dependency graph (here: `[auth/login, shop/checkout]`).
2. Skips anything already replayed on this Page (tracked via a
   per-Page `WeakMap`).
3. Runs the chain in topological order.
4. On any step failure, stops and reports `failedAt` — dependents
   beyond the failure are NOT attempted.

## Programmatic entry point

For uses outside `recipeDriver` (Playwright Test fixtures,
verifyAndPromote setup), call the resolver directly:

```ts
import { runRecipeWithRequires } from "chaosbringer";

const result = await runRecipeWithRequires({
  page,
  recipe: store.get("shop/checkout")!,
  store,
  // Caller maintains the dedup set across iterations.
  alreadyRan: new Set<string>(),
  onProgress: (ev) => {
    if (ev.kind === "complete") {
      console.log(`${ev.recipe}: ${ev.result.ok ? "ok" : "fail"}`);
    } else if (ev.kind === "skip") {
      console.log(`${ev.recipe}: skipped (already-ran)`);
    }
  },
});

console.log(`ok=${result.ok} sequence=${result.ranSequence.join(" → ")}`);
if (result.failedAt) {
  console.log(`broke at ${result.failedAt}: ${result.results[result.failedAt]?.failedAt?.reason}`);
}
```

`alreadyRan` is mutated by the runner — pass the same `Set` to
sequential calls in the same session to amortise the chain cost.

## Topology + safety

`resolveDependencies(recipe, store)` exposes the sort algorithm directly:

- **Diamond dedup:** `top → [left, right]`, both `→ base`, yields
  `[base, left, right, top]` (4 entries, not 5).
- **Cycle detection:** throws `cycle in requires chain (a → b → a)`
  on circular dependencies.
- **Self-loop guard:** `requires: ["self"]` on `self` throws.
- **Unresolved name:** missing recipe throws
  `recipe "X" is required by "Y" but not found in store`.
- **`__`-prefixed names are skipped:** the `repairRecipe()` provenance
  marker `"__repaired-from-v1"` doesn't trip the resolver.

`recipeDriver({ chainRequires: false })` opts out for callers who
want the legacy metadata-only semantics.

## Delta-debugging the regression trace

Phase D's `investigate()` now accepts `minimize: true`. After
reproduction, it re-replays subsets of the captured trace and keeps
the shortest one that still triggers the goal.

```ts
import { investigate } from "chaosbringer";

await investigate({
  failure: { url: "...", signature: "..." },
  driver: aiDriver,
  store,
  minimize: true,                    // ← enable
  minimizeMaxReplays: 50,            // optional cap; defaults to N²
});
```

Algorithm: **1-minimal delta debugging.**
- Greedy: try removing one step at a time, restart from the top after
  each successful removal.
- O(N²) worst-case replays. For typical N ≤ 20 this is 30–60 seconds
  of extra browser time.
- Always converges (length strictly decreases). Result is "1-minimal":
  removing any single step would make reproduction fail.

Direct programmatic use (when you have a trace but not via
`investigate()`):

```ts
import { minimizeRecipeTrace } from "chaosbringer";

const result = await minimizeRecipeTrace({
  trace,
  goal,
  setupPage: async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(failureUrl);
    return { page, cleanup: () => ctx.close() };
  },
});
console.log(`${result.originalLength} → ${result.minimizedLength} (${result.replays} replays, ${result.reason})`);
```

## Why "1-minimal" and not full ddmin

Standard ddmin (Zeller's algorithm) uses binary partitioning to find
a 1-minimal result faster (`O(N log N)` typical). We implement the
simpler greedy version because:

- For N ≤ 20 (a typical AI trace), the constant factor wins.
- The greedy version is trivial to read and audit.
- Both produce the same final length — the difference is replay count.

If your AI driver produces 100+ step traces and replay cost matters,
file an issue and we'll add a `mode: "ddmin"` knob.

## Gotchas

- **`requires` is per-recipe-name, not per-instance.** Two recipes
  both requiring `auth/login` will share the same dedup entry — the
  login runs once, then both dependents.
- **Dedup is per Page.** Closing the page (or running on a fresh
  worker) resets. This matches `BrowserContext`-level isolation
  semantics.
- **Minimisation runs against the SAME goal** the trace satisfied. If
  the goal's `successCheck` is non-deterministic (rare — but e.g.
  flaky console error timing), minimisation may shrink too far.
  Audit the resulting recipe before committing it to the store.
- **The raw trace is preserved.** `investigate.result.trace.steps`
  remains the full AI trajectory; only the stored recipe is
  minimised. Useful for forensics if minimisation feels wrong.

## Related

- The full AI flywheel: [`./ai-flywheel.md`](./ai-flywheel.md)
- Static skill library + recipe lifecycle: [`./ai-recipe-skills.md`](./ai-recipe-skills.md)
- Concepts borrowed from browser-harness + WebMCP: [`./browser-harness-concepts.md`](./browser-harness-concepts.md)
