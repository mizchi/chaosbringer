# Find out what actually broke

A red CI log says "SLO failed". The actual diagnosis flow is three steps:

1. **`report.errors`** — what error fired, on which page / step.
2. **`failureArtifacts`** — HTML + screenshot + Playwright trace of the moment.
3. **HAR replay** — reproduce locally without the SUT running.

## Step 1 — Read `report.errors` first

Both `LoadReport` (from `scenarioLoad`) and `CrawlReport` (from `chaos`)
carry the structured error list:

```ts
const { report } = await scenarioLoad({ /* ... */ });

// Capped flat list, sorted by timestamp.
for (const e of report.errors.slice(0, 10)) {
  console.log(`[${e.scenarioName}/${e.stepName}] iter=${e.iteration} ${e.message}`);
}
```

For the crawler, errors are per-page and grouped into clusters:

```ts
const report = await chaos({ /* ... */ });
for (const c of report.errorClusters) {
  console.log(`(${c.count}×) ${c.signature.kind}: ${c.signature.message}`);
  console.log(`  first seen on: ${c.firstUrl}`);
}
```

Cluster signatures collapse "the same stack trace fired 200 times" into a
single row — read that first, dive into individual errors only after.

## Step 2 — Failure artifacts (HTML + screenshot + trace)

`chaos()` writes one directory per failed page when `failureArtifacts.dir` is
set:

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  faultInjection: [faults.status(500, { urlPattern: /\/api\//, probability: 0.2 })],
  failureArtifacts: {
    dir: "./out/failures",         // one subdir per failed page
    saveHtml:       true,           // post-failure DOM
    saveScreenshot: true,           // PNG of the viewport
    saveTrace:      true,           // Playwright trace.zip — open with `playwright show-trace`
    maxArtifacts:   20,             // cap so a flaky run doesn't fill the disk
  },
});
```

Open the trace with:

```bash
pnpm exec playwright show-trace ./out/failures/<page>/trace.zip
```

The trace timeline shows every action + every network response with the
browser's view of the world at the moment of failure.

## Step 3 — HAR record / replay (reproduce without the server)

If the bug needs specific network responses to reproduce, record a HAR once
and replay against it forever:

```ts
// First run — record.
await chaos({
  baseUrl: "http://localhost:3000",
  har: { path: "./out/run.har", mode: "record" },
  seed: 42,
});

// Subsequent runs — replay (server can be down).
await chaos({
  baseUrl: "http://localhost:3000",
  har: { path: "./out/run.har", mode: "replay", notFound: "abort" },
  seed: 42,
});
```

`notFound` is the safety knob: `"fallback"` lets unmatched requests hit the
real network (good for partial recording); `"abort"` fails them (good for
"freeze this scenario in a unit test").

## Reproducing a specific failure

The crawler is deterministic given the same `seed`. If a CI run failed with
`seed: 1234`, run locally with the same seed to get the same action sequence
back. For `scenarioLoad` the seed is per-run; failures are reproducible only
in aggregate, not on a specific iteration. Use HAR replay if you need
deterministic input.

## Gotchas

- **`saveTrace: true` is expensive.** Each trace is ~5-50MB. Set `maxArtifacts`
  in CI or you'll fill the runner.
- **Replay does not replay client-side timing.** `setTimeout` / animation
  frames run at real time; only network responses come from the HAR.
- **HAR doesn't help with chaos.** Chaos faults are injected at the route
  *during the live run*. A replay against a recorded HAR will replay the
  *response that the fault produced*, not the fault itself.

## Related

- Feature surface: search `failureArtifacts` / `har` in
  `packages/chaosbringer/src/types.ts` for the full option shape.
- Wire failure artifact upload into CI: [`./github-actions.md`](./github-actions.md)
