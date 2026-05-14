# Realistic think-time shaping

Workers without think time hammer the SUT at native CPU speed and end up
load-testing your *test rig*, not your app. The default
(`uniform 1000–3000ms`) is fine for browsing scenarios; tighten or shape it
when you're chasing specific traffic patterns.

## The three distributions

```ts
import { defineScenario } from "chaosbringer";

defineScenario({
  name: "demo",
  // Scenario-level default — applies to every step unless overridden.
  thinkTime: { minMs: 800, maxMs: 2500, distribution: "uniform" },
  steps: [
    {
      name: "browse",
      // No override → inherits scenario-level (uniform 800-2500ms).
      run: async (/* ... */) => {},
    },
    {
      name: "click-buy",
      // Cluster around 200ms — real users hesitate before paying.
      thinkTime: { minMs: 100, maxMs: 400, distribution: "gaussian" },
      run: async (/* ... */) => {},
    },
    {
      name: "poll-status",
      // No wait — batch / fire-and-forget traffic.
      thinkTime: { distribution: "none" },
      run: async (/* ... */) => {},
    },
  ],
});
```

Override precedence: **step > scenario > runner-default**. The runner-default
is set on `scenarioLoad({ thinkTime })`.

## What each distribution does

| Distribution | Behaviour | Use for |
|---|---|---|
| `uniform` (default) | `min + rand * (max - min)` | Generic browsing — wide spread. |
| `gaussian` | Box-Muller around the midpoint, σ = `(max-min)/4`, clamped | Concentrated around a target latency. |
| `none` | Always 0 | Batch traffic, polling, "stress" scenarios. |

## Tuning hints

- **For RPS targets**: pick `minMs = maxMs = 60_000 / (target_rps_per_worker)`.
  Example: 10 workers at 30 RPS total = 3 RPS per worker = 333ms wait.
  Use `distribution: "uniform"` or `"none"` (deterministic).
- **For realistic browsing**: defaults (`uniform 1000-3000ms`) approximate
  a moderately-engaged user. For "frantic" sessions, drop the floor to 200ms.
- **For form-fill traffic**: `gaussian 1500-4000ms` per field — real typing
  has variance but doesn't go below ~1s for the first character.

## Verify the actual distribution

`pickThinkTimeMs` is exported so you can plot it before running:

```ts
import { pickThinkTimeMs } from "chaosbringer";

const samples = Array.from({ length: 10_000 }, () =>
  pickThinkTimeMs({ minMs: 100, maxMs: 400, distribution: "gaussian" }),
);
console.log("min", Math.min(...samples), "max", Math.max(...samples));
console.log("mean", samples.reduce((a, b) => a + b) / samples.length);
```

## Gotchas

- **Think time inflates total run time.** 10 workers × `thinkTime 1-3s` ×
  10 steps ≈ 10–30s per iteration. A "1-minute run" yields only 2–6
  iterations per worker. Either drop the think time or extend `duration`.
- **Deadline checks happen at step boundaries.** A 30s `duration` with a
  20s think time can overrun by 20s if a worker just started waiting at
  t=29s. Use small think times if you need a hard wall-clock.
- `distribution: "none"` is the right choice for SLO experiments — it
  removes a source of variance so latency stats reflect server behaviour,
  not your think-time RNG.

## Related

- Feature doc: [`docs/recipes/scenario-load.md`](../recipes/scenario-load.md)
