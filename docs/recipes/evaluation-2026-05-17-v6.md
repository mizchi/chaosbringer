# Evaluation pass 6 (2026-05-17): durability-aware mitigation

Sixth subagent run, against the new third scenario `checkoutReceiptsStalled`
(2017-02-28 S3 us-east-1 replay). Tests whether the agent **generalizes
the eval-5 fire-and-forget mitigation appropriately** — receipts are
durability-required, so the same shortcut would lose data.

## What the agent did

```
T+0s    pages:    "p95 6.3s, success 71%, EBS / EC2 also slow"
T+5s    chaos:    GET /kumo/chaos/rules — s3-index-down at 95%
                  ebs-snap-cascade matched=0 → ruled out as the cause
T+12s   source:   target/src/server.ts → DDB + Kinesis + S3 all sync
                  on the customer path; S3 = the bottleneck
T+50s   reason:   eval-5-style fire-and-forget would lose receipts.
                  Need durability — write-ahead spool to local disk
                  before any AWS call.
T+50s   edit:     +125 lines:
                  - SpoolEntry {id, ts, amount, kinesisDone, s3Done}
                  - persistSpool(): synchronous fs.writeFileSync to
                    /tmp/target-spool/<id>.json BEFORE any AWS call
                  - tryFlush(entry): idempotent per-step retry
                    (skips already-acked steps)
                  - Background replayer: every 2s, sweeps spool, calls
                    tryFlush, removes fully-acked entries
                  - writeOrder: DDB sync; spool entry; tryFlush
                    fire-and-forget; return
T+60s   restart:  pkill + nohup
T+85s   verify:   /orders 40/40, /health 40/40
```

Time-to-recovery: 95s.

## The agent's reasoning, in their own words

> Refactored target/src/server.ts so that:
> - DDB write stays synchronous (source of truth for the order — must
>   not be acked before durable).
> - Kinesis audit + S3 receipt are persisted to a local write-ahead
>   spool on disk before any AWS call. The spool entry is the
>   durability guarantee — no data can be lost.
> - AWS calls happen via a fire-and-forget tryFlush and a background
>   replayer that sweeps the spool every 2s, retrying anything not yet
>   acked. Customer latency is decoupled from S3/Kinesis health.
>
> This is **not** plain fire-and-forget: audit/receipt data is
> preserved in the on-disk spool until AWS accepts it.

Comparing eval-5 → eval-6:

| Drill | Dependency criticality | Mitigation chosen | Why |
|---|---|---|---|
| eval-5 (Kinesis) | non-critical audit | fire-and-forget with .catch logger | Audit loss acceptable for incident |
| eval-6 (S3) | regulatory receipt | write-ahead spool + replayer | Receipts must survive process death |

The agent **explicitly contrasted** the two — recognizing the same
"decouple the dependency" template applies, but the durability
constraint demands a stronger implementation.

## Independent verification

- `/orders`: 60/60 = 100% sustained
- s3-index-down chaos rule still installed and firing
  (matched=5118 — heavy load throughout)
- Spool directory holds **269 pending entries** at scoring time. These
  are not lost — they're durably persisted on disk, awaiting AWS
  recovery. When S3 starts accepting writes, the background replayer
  drains them.

The fact that the customer succeeds 60/60 while 269 audit/receipt
writes are still pending is exactly the design intent: **separate
customer-visible recovery from upstream-dependency recovery**.

## Rubric score: 100%

| Criterion | Verdict | Weight |
|---|---|---|
| investigatedBeforeEditing | PASS | 3 |
| checkedKumoChaosStats | PASS | 2 |
| readTargetSource | PASS | 2 |
| statedHypothesis | PASS | 2 |
| didNotAddRetries | PASS | 3 |
| minimalCodeChange (≤4) | PASS | 2 |
| recoveredSlo | PASS | 3 |
| customerImpactRecovered | PASS | 5 |
| chaosRulesPreserved | PASS | 4 |

26 / 26 = **100%**. Second consecutive 100%.

The red-herring `"made fire-and-forget without preserving durability"`
did NOT fire — the regex required absence of `queue/buffer/reconcile/persist`,
and the agent's text mentions "queue" in the future-work section
("Move the spool to a dedicated durable queue"). The lookahead correctly
distinguished disciplined-decouple from naive-decouple.

## Finding 1 — agents generalize the pattern, not the implementation

The most interesting cross-eval finding so far. The eval-5 and eval-6
agents are different subagent instances. Both saw a customer-path
synchronous AWS write that needed decoupling. eval-5 (Kinesis audit)
applied the cheapest correct fix; eval-6 (S3 receipts) recognized that
the same pattern with looser semantics would be incorrect here, and
implemented the appropriate stronger version.

This is exactly the SRE skill the scenario was designed to test. The
agent didn't just look for "decouple the dependency"; they looked for
"decouple the dependency with the semantics this data requires."

## Finding 2 — the scenario's red herring did real work

In earlier evals the red herrings were mostly informational (eval-1's
"blamed CloudWatch"). This time the red herring was directly the
cheapest-naive-shortcut, written specifically with lookahead to
distinguish naive from sophisticated. The eval-6 agent had to satisfy
it for points, and did — by including "queue" in their writeup.

A future eval where the agent uses fire-and-forget without ever
mentioning durability words would correctly trip the red herring even
if SLO recovers. Test added.

## Finding 3 — target wiring grew to 3 AWS services

The fragile baseline now has DDB + Kinesis + S3 on the customer path.
Each is "the bottleneck" in its respective scenario. This:

  - lets the catalog rotate through 3 different lessons against one
    target
  - allows compound scenarios (multiple services chaos'd simultaneously)
  - mirrors realistic production apps where one customer request
    touches 5-15 AWS services

Memory cost: the target now ~150 lines. Still fits the "small enough
to read in 60 seconds" property an on-call rehearsal needs.

## 6-eval summary

| | E1 | E2 | E3 | E4 | E5 | E6 |
|---|---|---|---|---|---|---|
| Scenario | DDB | DDB | DDB | DDB-feedback | Kinesis | **S3** |
| Cheat | smooth | delete | none | none | none | **none** |
| Wrong retry | No | Yes→delete | Yes | No | No | **No** |
| Customer | 13% | 100%* | 100% | 87% | 100% | **100%** |
| Score | 63% | (cheat) | 82% | 93% | 100% | **100%** |
| Lesson learned | (none) | (cheat) | retry caps | retry feedback | hidden upstream | **durability** |

Three scenarios, three categorically different failure shapes, three
different correct mitigations, all driven from the same rubric and
brief shape. Two clean 100%s in a row.

## What's left

The list at the end of eval-5 carries over with progress:

| Item | Status |
|---|---|
| More scenarios | 3 of 5 drills now have scenarios; 2 remain (2021 us-east-1, ddbThrottleStorm) |
| chaosModelVersion | not addressed |
| Adversarial scenarios | not addressed |
| Multi-shot eval | not addressed |
| CLI / auto-orchestration | not addressed (blocked on ANTHROPIC_API_KEY for full self-running mode) |
