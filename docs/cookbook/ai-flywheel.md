# The AI ↔ Recipe flywheel

Combine the AI driver, the recipe store, scenario load, and the
`investigate()` runner into a four-phase loop. Each pass through
grows the skill library, the chaos surface gets cheaper to test, and
new bugs auto-produce regression recipes that join the library.

```
                       ┌───────────────────────────────────────────────────┐
A. Discovery           │  goal=completion + aiDriver + tracingDriver       │ slow
   (AI explores)       │      ↓ ActionTrace                                │ expensive
                       │      ↓ extractCandidate()                         │ small N
                       │      → candidate Recipe                           │
                       └───────────────────────────────────────────────────┘
                                                  │
                                                  ▼
                       ┌───────────────────────────────────────────────────┐
B. Verification        │  verifyAndPromote() K runs, fresh contexts         │ batched
   (auto-promote)      │      ↓ success ≥ 0.8 → status = "verified"        │ medium cost
                       └───────────────────────────────────────────────────┘
                                                  │
                                                  ▼
                       ┌───────────────────────────────────────────────────┐
C. Production          │  scenarioLoad + recipeDriver + faultInjection      │ fast
   (cheap chaos)       │      ↓ verified recipes replay, NO LLM             │ cheap
                       │      ↓ chaos breaks things, errors logged           │ N → ∞
                       └───────────────────────────────────────────────────┘
                                                  │ on failure
                                                  ▼
                       ┌───────────────────────────────────────────────────┐
D. Investigation       │  investigate({ failure }) starts a fresh AI run    │ surgical
   (AI debugs)         │      ↓ tracingDriver records the reproducing path  │ medium cost
                       │      ↓ extractCandidate(origin: "regression")     │ 1 per failure
                       │      → regression Recipe goes back into the library │
                       └───────────────────────────────────────────────────┘
                                                  │
                                                  └──→ back to B → C
```

The flywheel: **discovery (A) and investigation (D) feed the library;
production (C) burns through the library cheaply and surfaces new
failures, which D turns back into library entries.** Discovery shrinks
over time as the AI has less unknown territory; investigation grows in
yield as the chaos surface tightens.

## Phase A: discovery (`tracingDriver`)

Wrap any inner Driver — typically `aiDriver` — with `tracingDriver`.
Every successful action accumulates into an `ActionTrace`; when the
Goal's `successCheck` flips true, the trace is finalised and ready
for `extractCandidate`.

```ts
import {
  aiDriver,
  anthropicDriverProvider,
  chaos,
  completionGoal,
  completionByUrl,
  extractCandidate,
  goals,
  RecipeStore,
  tracingDriver,
} from "chaosbringer";

const goal = goals.completion({
  task: "Buy a T-shirt and reach the thanks page",
  successCheck: completionByUrl("/thanks"),
});

const store = new RecipeStore({ localDir: "./chaosbringer-recipes" });

const tracing = tracingDriver({
  inner: aiDriver({
    provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    goal: goal.objective,
  }),
  goal,
  onTraceComplete: async (trace) => {
    const candidate = extractCandidate(trace, {
      name: "shop/buy-tshirt",
      description: "Add a T-shirt and complete checkout",
    });
    store.upsert(candidate);
  },
});

await chaos({
  baseUrl: "http://localhost:3000",
  driver: tracing,
  maxActionsPerPage: 30,
});
```

`tracingDriver` captures `click` / `fill` / `navigate` actions. Other
verbs (scroll, hover) are silently skipped — those don't round-trip
through a JSON recipe. For form fills with non-generic values, pass
`fillValueFor: (selector, step) => string` so the trace records what
was actually typed.

## Phase B: verification (`verifyAndPromote`)

Once a candidate exists, prove it's stable across N fresh contexts.

```ts
import { chromium } from "playwright";
import { verifyAndPromote } from "chaosbringer";

const browser = await chromium.launch();
const candidate = store.get("shop/buy-tshirt")!;

const verdict = await verifyAndPromote(store, candidate, {
  runs: 5,
  minSuccessRate: 0.8,
  verbose: true,
  setupPage: async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    return { page, cleanup: () => ctx.close() };
  },
});

console.log(`promoted=${verdict.promoted} rate=${verdict.successRate}`);
```

5/5 → `verified`. 1/5 or 2/5 → `demoted`. In between → still
`candidate`, gather more data on the next run.

## Phase C: production (`scenarioLoad` + `recipeDriver` + faults)

The cheap, scaled phase. Verified recipes replay without LLM calls;
network / runtime faults run on top. Every error that fires is a
candidate for Phase D.

```ts
import { compositeDriver, faults, recipeDriver, weightedRandomDriver } from "chaosbringer";
import { chaos } from "chaosbringer";

const driver = compositeDriver({
  drivers: [
    recipeDriver({ store, goal: "completion" }),    // 0 cost
    weightedRandomDriver(),                          // fallback
  ],
});

const report = await chaos({
  baseUrl: "http://localhost:3000",
  driver,
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\//, probability: 0.1, name: "api-500" }),
  ],
  invariants: [/* ... */],
});

// Each error cluster becomes a failure candidate for Phase D.
const failures = report.errorClusters.map((c) => ({
  url: c.firstUrl,
  signature: c.signature.kind + "-" + c.signature.message.slice(0, 20).replace(/\W+/g, "-"),
  errorMessages: [c.signature.message],
  notes: `seen ${c.count}× during chaos`,
}));
```

Notes: `recipeDriver` here is wrapped by `weightedRandomDriver` —
when no recipe matches the current page, the heuristic takes over so
the crawl never stalls. Add an `aiDriver` in the chain if you want
AI exploration on uncovered pages too.

## Phase D: investigation (`investigate`)

Hand each failure to the AI again, but this time with the failure's
context wired into the Goal. The AI's job is to reproduce the bug
with the *smallest* sequence of actions. The output is a
`regression`-origin recipe that goes straight into the store.

```ts
import { aiDriver, anthropicDriverProvider, investigate } from "chaosbringer";

const investigator = aiDriver({
  provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});

for (const failure of failures) {
  const result = await investigate({
    failure,
    driver: investigator,
    store,
    budget: 20,
    verbose: true,
  });
  console.log(
    `${failure.signature}: reproduced=${result.reproduced} ` +
    `(${result.trace.steps.length} steps in ${result.durationMs}ms)`,
  );
}
```

Outputs:
- `result.reproduced: boolean` — did the goal's `successCheck` flip true?
- `result.recipe: ActionRecipe | null` — captured + stored when reproduced
- `result.trace` — the raw trajectory for debugging

`investigate()` opens its own browser context, so it doesn't interfere
with a parallel chaos run. Pass a shared `browser` to amortise launch
cost when batching many failures.

## The full loop in one script

```ts
async function flywheel() {
  // A: discovery on a small budget (only when the library is sparse)
  if (store.verified().length < 3) {
    await runDiscovery();   // uses tracingDriver as above
  }

  // B: verify any new candidates
  for (const c of store.list().filter((r) => r.status === "candidate")) {
    await verifyAndPromote(store, c, { runs: 3, setupPage });
  }

  // C: cheap chaos at scale
  const report = await scenarioLoad({
    baseUrl,
    duration: "5m",
    scenarios: [{ scenario: shopScenario, workers: 10 }],
    faultInjection: [/* ... */],
  });

  // D: investigate everything that broke
  for (const e of report.errors.slice(0, 10)) {
    await investigate({
      failure: { url: baseUrl + "/", signature: e.stepName, errorMessages: [e.message] },
      driver: investigator,
      store,
    });
  }
}
```

## Gotchas

- **The investigator can refuse.** `result.reproduced === false` when
  the AI burned its budget without re-triggering the failure. That's
  fine — log the failure for later, keep going.
- **`tracingDriver` only captures successful actions.** Failed
  clicks / navigations do not enter the trace, so the recipe is
  always replayable in principle. The post-step `expectAfter` clauses
  in the recipe catch silent regressions during replay.
- **Recipe step values are coarse.** `click` / `navigate` round-trip
  cleanly; `fill` defaults to `"test input"` because the `ActionResult`
  doesn't carry the typed value. For real form journeys, supply
  `fillValueFor` to the tracingDriver so the captured value reflects
  reality.
- **`extractCandidate` infers a URL precondition from the start URL.**
  A recipe captured on `/cart` won't fire on `/`. Pass
  `inferUrlPreconditions: false` if you want a URL-agnostic recipe.
- **The investigator's candidate enumerator is coarser than the
  crawler's.** It looks at `data-testid` → `id` → `aria-label` →
  text-based selectors. If your app has none of those signals, the
  investigation will struggle to find a stable click target.
- **Phase D is not zero-cost.** It does call the LLM. Budget it via
  `aiDriver({ budget })` and cap concurrent investigations.

## Related

- The static skill library by itself: [`./ai-recipe-skills.md`](./ai-recipe-skills.md)
- The driver framework: [`../recipes/drivers.md`](../recipes/drivers.md)
- Demo runs A + B + D end-to-end: [`examples/recipe-skills/`](../../examples/recipe-skills/)
