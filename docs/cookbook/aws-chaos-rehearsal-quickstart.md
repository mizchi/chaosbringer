# Run an AI on-call recovery drill

End-to-end reproduction guide for the AWS chaos rehearsal. The harness
picks a real-incident-shaped scenario, hands an agent (your choice of
model) a vague PagerDuty-style page, and scores the result against a
rubric that values process — not just whether SLO came back.

22 scenarios across 9 capability tiers, three storage protocols
(DynamoDB / S3 / Kinesis / Postgres), three fault layers
(AWS-SDK-mediated / JS-level / TCP-level), and three customer-impact
probes (curl / SPA-driven chaosbringer journey / per-trace forensics).

## Prerequisites

- **Node 22+** with `pnpm`
- **Go 1.21+** to build kumo
- **PostgreSQL 14+** for the storage-diversity scenarios (Postgres can
  be skipped if you only want the AWS-side scenarios)
- **Playwright + Chromium** (auto-installed via `npx playwright install`)
- An agent / model you can drive from the command line — Claude Code,
  the Anthropic SDK, OpenAI CLI, your own wrapper, etc.

## One-shot setup

```sh
git clone <chaosbringer> && cd chaosbringer
pnpm install
./examples/aws-chaos-rehearsal/scripts/bootstrap.sh
```

`bootstrap.sh` is idempotent and handles:

- Building `kumo` (clones `mizchi/kumo` into `/tmp/kumo-src`, builds
  to `/tmp/kumo-new`)
- Starting `kumo` with chaos endpoints enabled on `:4566`
- Starting the read-only kumo proxy on `:4567` (agent's view —
  GET-only, so the agent can't disable chaos)
- Creating AWS resources kumo serves (`orders` DDB table, `events`
  Kinesis stream, `receipts` S3 bucket, `tier-config` DDB table)
- For Postgres scenarios only: starting Postgres, creating the
  `rehearsal` DB + `chaos` user + `orders` table
- For TCP-proxy scenarios only: starting `scripts/tcp-chaos-proxy.ts`
  on `:14566` (data) / `:14567` (admin)

Skip `bootstrap.sh` and follow `examples/aws-chaos-rehearsal/README.md`
if you want to do each step manually.

## Run one drill

```sh
cd examples/aws-chaos-rehearsal

# 1. Prepare an env for a scenario.
pnpm prepare silent-data-loss my-run-1
# → resets target, installs chaos, writes brief + workdir
# → prints the brief on stdout (paste into your agent's prompt)

# 2. Let the agent work. Three ways to invoke:
#    a) Manual:    paste the brief into Claude / GPT / whatever
#    b) CLI:       claude --resume-from-stdin < /tmp/wom-my-run-1/agent-brief.txt
#    c) Subprocess driver via sweep (see below)
#    The agent journals to /tmp/wom-my-run-1/journal.md as it works.

# 3. Score when the agent stops.
pnpm score silent-data-loss my-run-1
# → /tmp/wom-my-run-1/{debrief.md,report.json}
```

A typical good run scores 80-100%. The debrief explains each rubric
verdict (PASS / FAIL with a hint) plus per-trace forensics — which
journey iterations hit which chaos rules.

## Scenario catalog (22 scenarios)

| id | Tier | Layer | Lesson |
|---|---|---|---|
| `ddb-throttle-warmup` | calibration | AWS | smoke test |
| `silent-credit-card-failures` | 1 (2015 DDB) | AWS | retry storms amplify under feedback |
| `morning-rush-cognito` | 1 (2020 Kinesis) | AWS | hidden upstream dependency |
| `checkout-receipts-stalled` | 1 (2017 S3) | AWS | durability disqualifies fire-and-forget |
| `misleading-chaos` | 5 (adversarial) | AWS | chaos isn't always the cause |
| `control-plane-degraded` | 1 (2021 us-east-1) | AWS | STS hot-path dependency |
| `quota-saturated` | 3 | AWS | soft-quota vs throttling |
| `ddb-dns-race` | 2 (2025 DDB) | AWS / connection | hangup-at-connect mental model |
| `tier-lookup-stampede` | 1 | AWS | ADD a cache (rare pattern) |
| `compound-incident` | 4 | AWS | two independent issues, both must be fixed |
| `restart-trap` | 5 | AWS | reflex resistance — "do nothing" can be right |
| `no-hints-storm` | 5 | AWS | discovery without alert breadcrumbs |
| `duplicate-orders` | 6 | AWS | idempotency violation under TimeoutError retry |
| `silent-data-loss` | 7 | AWS | Byzantine fault — upstream lies (silentSuccess) |
| `credentials-revoked` | 8 | AWS | recognize "can't fix from app side" |
| `client-timeout-misconfig` | 9 | AWS / client | bug is in the SDK config, not upstream |
| `multi-service-cascade` | 10 | AWS / topology | symptom in Order, cause in Payment |
| `pg-pool-exhaustion` | 11 | Postgres | pool blocked; raise max / statement_timeout |
| `pg-replica-lag` | 12 | Postgres | read-after-write violation; INSERT...RETURNING |
| `pg-slow-writes` | 12 | Postgres | per-query latency cap (vacuum-lock pattern) |
| `network-rst-idempotency` | 13 | AWS / network | mid-flight RST; server-side may have committed |
| `dns-storm` | 13 | network / TCP | pre-connect refusal; socket keepalive / failover |

## Wiring your own agent

Two patterns:

### A. Interactive: paste the brief

Whatever model you like. The brief is self-contained and includes the
journal path; the rubric works as long as the agent writes
`T+Ns <verb>: <note>` lines to `/tmp/wom-<run-id>/journal.md`.

### B. Subprocess driver (cross-agent sweep)

`pnpm sweep --driver <command>` runs N scenarios end-to-end against a
subprocess driver and emits a markdown matrix.

Driver contract (4 env vars):

```sh
WOM_SCENARIO_ID  scenario being run
WOM_RUN_ID       this iteration's run id
WOM_WORKDIR      /tmp/wom-<run-id>
WOM_BRIEF_PATH   file containing the brief (output of pnpm prepare)
```

Driver MUST write `journal.md` to `WOM_WORKDIR` before exiting. See
`scripts/drivers/noop-driver.sh` for the simplest shape and
`scripts/drivers/claude-code-driver.sh` for a real-agent example.

Sweep example:

```sh
pnpm sweep --driver "bash scripts/drivers/claude-code-driver.sh" \
           --scenarios silent-data-loss,duplicate-orders,multi-service-cascade \
           --driver-label claude-opus-4-7 \
           --report sweep-claude.md
```

Run the same sweep with a different `--driver-label` for each agent
you want to compare, then concat the matrices.

### C. Replay only (offline, no agent / no API key)

Fixtures under `examples/aws-chaos-rehearsal/fixtures/` contain
captured runs. `pnpm replay <fixture>` re-scores deterministically;
`pnpm sweep` walks every fixture and emits a matrix grouped by
scenario. The CI workflow at
`.github/workflows/aws-chaos-rehearsal-replay.yml` runs this on every
PR that touches the harness.

## Multi-shot for variance

```sh
for i in 1 2 3; do
  pnpm prepare silent-credit-card-failures "n3-r$i"
  # spawn agent...
  pnpm score silent-credit-card-failures "n3-r$i"
done

# Aggregate
pnpm report > /tmp/sweep.md
```

A single N=1 run is a sample, not a measurement. Score variance can be
20+ points across runs of the same scenario.

## What's actually being scored

Process-over-outcome rubric. Each scenario picks a weighted subset of
these primitives plus its own signature criteria:

- `investigatedBeforeEditing` — read source / chaos / pages first
- `checkedKumoChaosStats` — query `/kumo/chaos/*` to identify upstream
- `readTargetSource` — read the target's code path before changing it
- `statedHypothesis` — explicit reasoning before action
- `didNotAddRetries` — did NOT increase retry attempts (2015 anti-pattern)
- `minimalCodeChange` — focused intervention, not a rewrite
- `recoveredSlo` — probe SLO returned to threshold
- `customerImpactRecovered` — separate post-run probe of `/orders`
  confirms it; catches "probe smoothed, customer broken"
- `chaosRulesPreserved` — agent did not delete chaos to force recovery
- `noNewDuplicates` / `noSilentDataLoss` — state-correctness invariants
- `recognizedAsUnrecoverable` — for `credentials-revoked`
- `locatedRootService` / `mitigatedPoolNotRetries` / etc. —
  scenario-specific LLM-judged primitives

See `packages/aws-faults/src/wheel/scoring.ts` for the full menu.

## Customer-impact probe (#114)

`pnpm score` measures customer impact two ways:

- **Journey** (preferred) — if `recipes/<scenario-id>/` exists, runs N
  virtual users through a chaosbringer recipe against the target's
  SPA. Catches silent-data-loss / duplicate-write / stale-read /
  receipt-loss failures the curl probe is blind to.
- **Curl** (fallback) — `POST /orders × 30`. Used when no recipe
  library exists.

Mode appears in `report.json.customerProbe.mode` and the stdout.

## Trace forensics (#115)

Every SPA click generates a W3C `traceparent` that propagates target
→ AWS SDK → kumo. kumo records matched traceparents in a per-rule
ring buffer. After the journey, `eval-score` joins the SPA's
trace-log with kumo's recentTraces to emit per-iteration attribution:

```
Trace forensics: 7 iterations recorded, 4 hit chaos
  - found: 3 (0 hit chaos)
  - verify-missing: 4 (4 hit chaos)
```

Persisted in `report.json` under `traceLog[]` and `traceOutcomes`.

## Regression gating (#117)

```sh
pnpm replay silent-data-loss-baseline               # one fixture
pnpm sweep --fail-on-regression                     # all fixtures
```

Adding a fixture: copy a successful `/tmp/wom-*` into
`examples/aws-chaos-rehearsal/fixtures/<name>/`, then write
`_replay-inputs.json` (captured customer probe + chaos snapshot +
post-run probes), `llm-verdicts.json` (so the replay is offline), and
`expected.json` (canonical score + criterion outcomes).

## Wire your own target (#118)

```sh
pnpm prepare silent-data-loss my-run-1 \
  --target=./my-target-factory.ts
```

The user-supplied module default-exports a `TargetFactory` matching
`@mizchi/aws-faults`'s `RehearsalTarget` interface:

```ts
import type { TargetFactory } from "@mizchi/aws-faults";
const factory: TargetFactory = (env) => ({
  async boot() { /* spawn your service */ },
  async shutdown() { /* stop it */ },
  async restart() { /* cycle */ },
  customerUrl: `http://localhost:${env.port}/orders`,
  probeUrl: `http://localhost:${env.port}/health`,
  verifyUrl: (id) => `http://localhost:${env.port}/verify/${id}`,
  sourceRoots: ["./src"],
  async *logStream() { /* lines of stdout/stderr */ },
});
export default factory;
```

`examples/aws-chaos-rehearsal/target/src/target-factory.ts` is the
reference implementation wrapping the bundled Hono target.

## Going deeper

- `docs/recipes/aws-chaos-rehearsal.md` — design rationale
- `docs/recipes/wheel-of-misfortune.md` — Google SRE WoM adaptation
- `docs/recipes/incident-replay.md` — turn a post-mortem into a scenario
- `packages/aws-faults/README.md` — programmatic SDK reference
- `.claude/skills/aws-chaos-rehearsal/SKILL.md` — Claude Code skill form
