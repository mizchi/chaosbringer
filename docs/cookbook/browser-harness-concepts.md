# Concepts borrowed from browser-harness + WebMCP

Two open projects influenced the recipe layer's design after the
initial release. This recipe explains what we adopted and the API
surface that came from each.

| Source | Idea | API in chaosbringer |
|---|---|---|
| [browser-use/browser-harness](https://github.com/browser-use/browser-harness) | **Self-modifying skill library** — agent writes helpers as it goes | `tracingDriver` + `extractCandidate` + `repairRecipe` |
| browser-harness | **Domain skills** — playbooks scoped per host | `RecipeStore.byDomain(host)` |
| browser-harness | **`SKILL.md`** — natural-language seeds | `parseSkillMarkdown` + `seedToGoal` |
| browser-harness | **"Screenshots first"** doctrine | `tracingDriver({ screenshots: { dir } })` |
| browser-harness | **Coordinate clicks** — CDP-level fallback | `{ kind: "click-at", x, y }` step |
| [Chrome WebMCP](https://developer.chrome.com/blog/webmcp-mcp-usage) | **Page-declared tools** — site exposes structured ops | `loadPageScenarios(page)` reading `window.__chaosbringer` |
| WebMCP | **Intent over UI** — declare what to test, not how the DOM looks | Same — scenarios shipped with the app |
| browser-harness | **`agent_helpers.py`** auto-edits | `repairRecipe()` patches failing tails via AI |

---

## Domain-scoped recipes (`store.byDomain`)

Recipes already include a URL precondition. The store now indexes
those for cheap host-scoped lookup:

```ts
const store = new RecipeStore();
store.byDomain("github.com");      // → recipes with /github\.com/ in their precondition
store.byDomain("linkedin.com");    // → only LinkedIn recipes (plus any unscoped)
store.domains();                   // → ["github.com", "linkedin.com", ...]
```

Use this when you have a multi-site library and want each chaos run
to only see relevant skills:

```ts
const driver = recipeDriver({
  store,
  filter: (r) => r.preconditions[0]?.urlPattern?.includes("github") ?? false,
});
```

Recipes without a URL precondition are returned for **every** domain
— treat them as "global" skills (e.g. "dismiss a cookie banner").

## Page-declared scenarios (`loadPageScenarios`)

The killer feature borrowed from WebMCP: **the app self-declares the
scenarios it wants tested**.

```html
<!-- inside your app, dev/staging only -->
<script>
  window.__chaosbringer = {
    version: 1,
    scenarios: [
      {
        name: "shop/buy-tshirt",
        description: "Add a T-shirt and complete checkout",
        goal: "completion",
        preconditions: [{ urlPattern: "^/" }],
        steps: [
          { kind: "click", selector: "[data-test=tshirt]" },
          { kind: "click", selector: "[data-test=buy]" }
        ],
        postconditions: [{ urlPattern: "/thanks" }]
      }
    ]
  };
</script>
```

```ts
import { loadPageScenarios, RecipeStore } from "chaosbringer";

const store = new RecipeStore();
await page.goto("http://localhost:3000");
const harvested = await loadPageScenarios(page);
for (const r of harvested) store.upsert(r);
```

**Trust model.** Harvested scenarios become `candidate` recipes by
default — they still go through `verifyAndPromote` before
`recipeDriver` will replay them. Pass `trustPublisher: true` to skip
the dance for apps you fully own.

The shape mirrors `ActionRecipe` 1:1 so app developers only need to
learn one schema. Origin is recorded as `"page-declared"` for
provenance.

## Markdown skill seeds (`parseSkillMarkdown`)

For "domain experts can write tests in prose" workflows. Frontmatter
declares the meta-fields; body is the natural-language instructions
the AI driver consumes verbatim:

```markdown
---
name: shop/checkout-discount-flow
goal: completion
urlPattern: ^https?://[^/]+/?$
success:
  urlContains: /thanks
---
# Apply a discount and check out

1. Browse to the cart.
2. Click "Apply discount", enter code `SAVE10`.
3. Verify cart total dropped, then click Checkout.
4. Land on /thanks.
```

```ts
import { parseSkillMarkdown, seedToGoal, seedToCandidateRecipe,
         tracingDriver, aiDriver, anthropicDriverProvider, chaos } from "chaosbringer";
import { readFileSync } from "node:fs";

const seed = parseSkillMarkdown(readFileSync("./skills/discount-flow.md", "utf8"));
const goal = seedToGoal(seed);

const tracing = tracingDriver({
  inner: aiDriver({
    provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    goal: goal.objective,
  }),
  goal,
  onTraceComplete: async (trace) => {
    if (!trace.successful) return;
    const recipe = seedToCandidateRecipe(seed, trace);
    store.upsert(recipe);                       // candidate → verifyAndPromote later
  },
});

await chaos({ baseUrl: "http://localhost:3000", driver: tracing });
```

Once verified, the seed has been "compiled" into a runtime recipe
that replays without LLM calls. Origin: `"markdown-seed"`.

## Per-step screenshots (`tracingDriver({ screenshots })`)

`browser-harness`'s "screenshots first" doctrine: capture after every
meaningful action. Recommended for AI-driver runs — when `investigate()`
later tries to reproduce a regression, it'll have the visual context
the AI needs to recognise the failure shape.

```ts
const tracing = tracingDriver({
  inner: aiDriver({ ... }),
  goal,
  screenshots: {
    dir: "./out/artifacts/run-2025-05-14",
    mode: "viewport",            // or "fullPage" for tall scrolling pages
    // filenameFor: (i, kind) => `${i}-${kind}.png`,   // override if needed
  },
});
```

`trace.screenshots` lines up 1:1 with `trace.steps` once capture is
enabled. Capture is fire-and-forget — replay-critical and never blocks
the driver loop.

## Coordinate-fallback clicks (`{ kind: "click-at" }`)

Some SPAs mutate selectors on every render. When a recipe targets one
of those elements, the only stable reference is geometry. Recipes can
now include `click-at`:

```jsonc
{
  "kind": "click-at",
  "x": 240,
  "y": 480,
  "viewportHint": { "width": 1280, "height": 720 },
  "expectAfter": { "urlContains": "/details" }
}
```

`viewportHint` makes replay fail fast if the page is being run at a
different viewport size — better to skip than click the wrong thing
silently. Use sparingly: selector-based clicks are still preferred
because they survive viewport changes.

## Recipe self-repair (`repairRecipe`)

When a `verified` recipe starts failing at step N — usually because
the app shipped a UI change — instead of demoting and re-running full
Phase A discovery, hand the partial recipe to an AI driver:

```ts
import { repairRecipe, aiDriver, anthropicDriverProvider } from "chaosbringer";

const result = await repairRecipe({
  recipe: store.get("shop/buy-tshirt")!,
  store,
  driver: aiDriver({
    provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  }),
  baseUrl: "http://localhost:3000",
  repairBudget: 15,
  verbose: true,
});

if (result.repaired) {
  console.log(`v${result.recipe!.version} replaces v${result.recipe!.version - 1}`);
  console.log(`  prefix kept: ${result.failedAt} steps, AI added: ${result.newTailSteps}`);
}
```

Mechanics:
1. Replay step-by-step until it fails at step N.
2. From the post-prefix state, run the AI driver under a
   "repair" Goal whose `successCheck` = the original recipe's
   postconditions. The AI's job: reach the same end state, by any
   path.
3. On success, splice (`prefix[0..N) ++ AI tail`), bump `version`,
   re-upsert. Stats carry over.

If the AI doesn't converge within `repairBudget`, the recipe is left
unchanged — caller decides whether to retry, demote, or hand-fix.

## Verification cadence doctrine

Borrowed verbatim from browser-harness's SKILL.md: **verify after
every meaningful action, not at the end of the run.**

For chaosbringer that means:
- Recipe steps should carry `expectAfter` clauses, not rely on a
  single post-trace assertion.
- AI-driver loops should call `goal.successCheck` between each step
  (which `tracingDriver` already does).
- `investigate()` polls AFTER each step it executes, not only at the
  end of its budget.
- Screenshot capture, when enabled, fires per-step — making "what
  changed between steps N and N+1" diff-able after the fact.

The cost of an end-of-run assertion is "we know it broke; we don't
know which step broke it." Per-step verification is the difference
between a 5-minute and a 5-hour debugging session.

## Related

- The full AI flywheel: [`./ai-flywheel.md`](./ai-flywheel.md)
- Static skill library: [`./ai-recipe-skills.md`](./ai-recipe-skills.md)
- Recipe step grammar: [`../recipes/scenario-load.md`](../recipes/scenario-load.md) (overlap with `defineScenario` shape)
