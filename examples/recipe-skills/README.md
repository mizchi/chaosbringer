# recipe-skills

Self-contained demo of the recipe layer. Runs end-to-end with no API
key and no external server.

## Run

```bash
pnpm install
pnpm start
```

You should see:

```
Recipe 'shop/buy-tshirt' inserted as candidate

Verifying...
[verify shop/buy-tshirt] run 1/3: ok (180ms)
[verify shop/buy-tshirt] run 2/3: ok (152ms)
[verify shop/buy-tshirt] run 3/3: ok (148ms)
[verify shop/buy-tshirt] promoted (rate=1.00)

Verification: promoted=true  rate=1

After reload: status=verified successCount=3

Driving via recipeDriver:
[recipeDriver] matched shop/buy-tshirt
[recipeDriver] replayed shop/buy-tshirt ok (165ms)
recipeDriver fired: success=true  url=http://127.0.0.1:.../thanks
```

## What it shows

| Surface | Demonstrated as |
|---|---|
| `RecipeStore` (filesystem-backed JSON) | Atomic write to a tmp dir, re-load to prove persistence |
| `runRecipe` (replay engine) | Drives a hand-written recipe end-to-end on Chromium |
| `verifyAndPromote` (auto-promotion) | 3 fresh contexts × identical recipe → promoted to `verified` |
| `recipeDriver` (Driver wrapper) | Picks the verified recipe + replays it as a single `DriverPick` |
| `investigate()` (Phase D) | Given a captured failure (`/broken` fires a console.error), the runner navigates there, sees the error on load, and stores a `regression/...` recipe in the same store |

## Where to go next

The demo uses a deterministic "picking driver" in lieu of an actual LLM — it
just clicks whichever candidate description matches a regex. To run with a
real AI, swap that out for `aiDriver`:

```ts
import { aiDriver, anthropicDriverProvider, tracingDriver } from "chaosbringer";

const ai = aiDriver({
  provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  goal: goal.objective,
});

// Phase A: wrap with tracingDriver to capture candidates as you go.
// Phase D: pass `ai` directly to `investigate({ driver: ai, ... })`.
```

- The full flywheel walkthrough: [`docs/cookbook/ai-flywheel.md`](../../docs/cookbook/ai-flywheel.md)
- Static skill library only: [`docs/cookbook/ai-recipe-skills.md`](../../docs/cookbook/ai-recipe-skills.md)
