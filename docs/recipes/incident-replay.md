# Incident replay drills — methodology

Recipe for turning a public AWS post-mortem into an executable drill that
exercises the same anti-pattern an AI on-call needs to recognize.

The shipped catalog lives in
[`packages/aws-faults/src/drills/incidents/`](../../packages/aws-faults/src/drills/incidents/).
Currently:

| Drill | Real incident | Post-mortem |
|---|---|---|
| `aws_2015_09_20_dynamodb` | DynamoDB us-east-1 metadata-service overload, 55% error peak, retry storm | https://aws.amazon.com/message/5467D2/ |
| `aws_2017_02_28_s3` | S3 us-east-1 index subsystem outage with asymmetric read/write recovery | https://aws.amazon.com/message/41926/ |
| `aws_2020_11_25_kinesis` | Kinesis us-east-1 thread-limit exhaustion, 17h cascade to Cognito & CloudWatch | https://aws.amazon.com/message/11201/ |
| `aws_2021_12_07_useast1` | us-east-1 network-device congestion, control-plane impaired, clients failed to back off | https://aws.amazon.com/message/12721/ |

## Why incident replays (vs. generic chaos)

A generic drill — "throttle DynamoDB at 50%" — teaches the agent to spot
throttling. That's worth something, but it doesn't teach the *specific
anti-patterns* a real incident exposed:

- **2015 DDB**: adding retries makes a retry-storm-driven outage worse.
- **2017 S3**: reads can recover before writes; an app that conflates the
  two has a second outage at recovery time.
- **2020 Kinesis**: the user-visible failure ("login broken") is downstream
  of an invisible buffered dependency.
- **2021 us-east-1**: SDK default retry policy actively prevents the client
  back-off AWS depends on to recover.

These are the lessons real on-calls get. A drill that replays the shape of
the actual outage reproduces the conditions under which the lesson was
originally learned.

## Anatomy of a replay

A replay drill has three responsibilities:

### 1. Time profile

Real outages have a SHAPE — slow onset, peak, partial recovery, tail.
Drills compress this into seconds while preserving relative proportions.

```ts
import { compressTimeline } from "@mizchi/aws-faults/drills";

const phases = compressTimeline([
  { label: "onset",   realMinutes: 18,  rules: [...] },
  { label: "peak",    realMinutes: 149, rules: [...] },  // 55% errors
  { label: "recovering", realMinutes: 124, rules: [...] },
  { label: "tail",    realMinutes: 222, rules: [...] },
], /* totalDrillMs */ 90_000);
```

The orchestrator plays phases sequentially; **the last phase's rules stay
installed during the recovery window**. The agent must hold SLO at the
lingering condition, not wait it out.

### 2. Verbatim error shapes

When the post-mortem cites a number ("55% peak error rate"), use it
verbatim. Don't round, don't approximate — the published number IS the
test target.

When the post-mortem says "PutRecord and GetRecord errors," match the AWS
action names exactly via `match: { service, action }`. When it says
"clients failed to back off," use an `awsError` injection that returns the
SDK's recognized throttling code so the SDK's *own* retry path is what's
being exercised — not your code.

### 3. The cascade

Real incidents are rarely a single service. The 2015 DDB outage took down
SQS metadata caching and CloudWatch metrics; the 2021 us-east-1 outage
cascaded through STS/EC2/IAM/Route53. Install secondary rules for these
so the agent has to discover the actual upstream rather than treating each
symptom as a separate incident.

```ts
{
  // ...peak DDB throttling...
},
{
  id: "sqs-cascade",
  match: { service: "sqs" },
  inject: {
    kind: "awsError",
    probability: 0.2,
    awsError: { code: "ServiceUnavailableException", httpStatus: 503 },
  },
},
{
  id: "cw-cascade",
  match: { service: "monitoring", action: "PutMetricData" },
  inject: {
    kind: "awsError",
    probability: 0.3,
    awsError: { code: "InternalServerError", httpStatus: 500 },
  },
},
```

## Recipe: adding a new replay

1. **Find the post-mortem.** Public AWS post-mortems live at
   `https://aws.amazon.com/message/{id}/`. The status history and dashboard
   incident posts are also fair game.

2. **Extract the time profile.** Walk through the timeline section of the
   post-mortem and bucket events into 3-5 phases:
   - *onset*: first elevated errors
   - *peak*: maximum error rate (if published)
   - *partial recovery*: one subsystem returns
   - *tail*: residual errors during stabilization
   Note the duration of each in minutes — that's what `realMinutes` takes.

3. **Map error rates to `Inject` shapes.** If the post-mortem cites a
   percentage, use it as `probability` directly. If it cites latency
   numbers ("p99 of 8 seconds"), use them in `Latency.p99Ms`. If only
   error codes are cited, the SDK reaction matters more than the rate —
   pick a rate that exercises the retry path (~50% is usually right).

4. **Identify the cascade.** The post-mortem usually has a "Dependent
   Services" or "Customer Impact" section. Each named downstream is a
   second rule with lower probability — symptoms, not the cause.

5. **Write the brief.** The brief is what the AI agent reads first. Be
   specific about:
   - What user-visible symptom the agent sees (NOT the cause)
   - Link to the real post-mortem (the agent should treat it as
     documentation, not a spoiler)
   - The published lesson — what anti-pattern this incident exposed
   - What the acceptance criteria mean in context

6. **Pick acceptance numbers.** A drill that demands sub-100ms p99 is
   uninteresting (always fails). A drill that demands sub-10s p99 is also
   uninteresting (always passes). Aim for p99 thresholds at roughly 2-3×
   baseline, so a correct mitigation just barely passes.

## What good replays *don't* do

- They don't replicate exact byte-level error envelopes. Kumo's
  `awsError` injection writes the canonical JSON 1.0 / Query / REST
  envelope based on the matched request — that's what AWS SDKs parse,
  and matching field-by-field with the production response adds nothing.
- They don't model the human element of the post-mortem. "Engineers
  paged at 09:43" isn't a chaos rule.
- They don't try to reproduce the *root cause* — only the *failure
  pattern*. The 2017 S3 outage was caused by a typo'd command; we model
  the resulting S3 5xx pattern, not the typo.

## Running a replay

```ts
import { kumoChaos, runDrill } from "@mizchi/aws-faults";
import { incidents } from "@mizchi/aws-faults/drills";

const chaos = kumoChaos({ endpoint: "http://localhost:4566" });

const report = await runDrill({
  chaos,
  drill: incidents.aws_2015_09_20_dynamodb({
    probeUrl: "http://localhost:3000/health",
    durationMs: 120_000, // 2-minute drill; real outage was ~5 hours
  }),
  baselineMs: 10_000,
  recoveryTimeoutMs: 180_000,
});

console.log(report.passed ? "RECOVERED" : "TIMEOUT");
for (const phase of report.injectedByPhase) {
  const okRate = phase.samples.filter((s) => s.ok).length / phase.samples.length;
  console.log(`  ${phase.label}: ${(okRate * 100).toFixed(0)}% OK`);
}
```

The `injectedByPhase` field in the report gives the per-phase error curve.
Combined with the agent's tool-use transcript (logged to stderr during the
AI rehearsal), that's the artifact you put on a slide after the drill.
