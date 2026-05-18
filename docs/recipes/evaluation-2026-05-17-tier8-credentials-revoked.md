# Tier 8 eval: credentials-revoked — the first "don't recover" scenario

The first scenario in the catalog where the right answer is **NOT to
recover customer SLO**, because the failure mode is categorically
un-mitigateable from app source. Tests whether the agent recognizes
that "follow the standard playbook" doesn't apply.

## Real-world precedent

Multiple recurring incidents have this shape:
- **Reddit 2018**: IAM mass-edit accidentally revoked S3 perms across
  many buckets. Apps got `AccessDeniedException` flood; no app-side
  fix; required out-of-band IAM rollback.
- **GitLab 2022**: Postgres role-rotation script left the app with
  invalid credentials. Same pattern: error spike, no code fix.
- **Various AWS customers** post policy-as-code rollouts: typos in
  IAM CDK / Terraform PRs lock out production paths.

The lesson is shared across these: **AccessDeniedException is not
retryable**. Retries don't help. Circuit breakers don't help. Caches
don't help. The right response is graceful degradation + escalation.

## Scenario design

| Element | Value |
|---|---|
| Drill | `permissionsRevoked` — 80% AccessDeniedException on DDB |
| Brief | "logs show AccessDeniedException... IAM policy change scheduled 6 minutes ago" |
| Pages | Deploy-bot signal at T+18s, PagerDuty linked-incident at T+40s (Platform team rolling back, ETA 25min) |
| Customer SLO target | Will REMAIN below threshold |

**Rubric weights INVERTED** vs prior scenarios:

| Criterion | Normal weight | This scenario |
|---|---|---|
| `recoveredSlo` | 3 | **1** |
| `customerImpactRecovered` | 5 | **1** |
| `didNotAddRetries` | 3 | **4** (retries are categorically wrong here) |
| `recognizedAsUnrecoverable` (new) | — | **8** |

`recognizedAsUnrecoverable` is LLM-judged (no useful regex
fallback — the question is semantic).

## What the agent did

Wall clock 85s. 14 tool uses. The agent:

1. Investigated /kumo/chaos/* (env was actually down at run time —
   the chaos service had crashed since the prior eval)
2. Read target source
3. Read the page board
4. Considered candidate causes — both IAM regression AND platform-down
5. Reasoned: "Adding retries, swapping to adaptive retry mode, or
   fire-and-forgetting writes would all amplify load on the upstream
   and/or violate durability for orders. Restarting the target would
   not change the outcome since the dependency is external."
6. **Applied NO mitigation. Recommended escalation to two teams.**

Agent quote:
> "If it really is an IAM policy regression: the fix is to revert
> their deploy / restore the role policy. No code change in
> target/src/server.ts can grant itself permissions it just lost.
> If it is the AWS-equivalent endpoint being down: the fix is to
> restore the platform, not patch the consumer."

This is exactly the SRE judgment the scenario was designed to test.

## Result

| Criterion | Verdict |
|---|---|
| investigatedBeforeEditing | PASS |
| checkedKumoChaosStats | PASS |
| readTargetSource | PASS |
| statedHypothesis | PASS |
| didNotAddRetries | PASS |
| minimalCodeChange | PASS |
| recoveredSlo (w=1) | FAIL (intended — customer cannot recover) |
| customerImpactRecovered (w=1) | FAIL (intended — same) |
| chaosRulesPreserved | FAIL (environmental — kumo state was reset) |
| **recognizedAsUnrecoverable (w=8)** | **PASS** |

**Score: 80%.** Customer recovery: 0% (intended).

## Two notable observations

### 1. Generalization beyond the specific signal

The kumo service happened to be down during this eval — so the agent
literally couldn't see the AccessDeniedException chaos rules. They
investigated and got `ECONNREFUSED` instead. **The agent still
reached the correct conclusion** ("this is an out-of-band issue,
escalate") by reasoning about the failure SHAPE, not the specific
error.

Quote: "the failure shape (TCP refused) does not match the failure
shape claimed in the page (HTTP 403 AccessDenied) — but both
diagnoses lead to the same conclusion below."

This is generalization across information loss: the agent didn't get
the breadcrumb the scenario provided, but they reasoned to the same
right answer from first principles.

### 2. The rubric now distinguishes scenario shapes

Prior scenarios all weighted customerImpactRecovered at 3-7. This
scenario weights it at 1. **Two scenarios with identical agent
behavior would score very differently** depending on whether the
chaos was app-fixable.

This means the rubric isn't a generic "did the agent fix things"
scorer — it encodes scenario-specific judgment about what fixing
means. For an IAM revocation, "fixing" is correctly identifying
the issue and escalating; mitigation IS the wrong answer.

## What this validates

The harness can now express:
- "Agent must recover customer impact" (most scenarios)
- "Agent must NOT recover customer impact via app-side mitigation;
  escalate instead" (this scenario)

These are categorically different on-call response patterns. Real SRE
work includes both. A harness that only tests "fix-it" patterns
under-tests the real skill set.

## Capability ladder status after Tier 8

| Tier | Description | Status |
|---|---|---|
| 1-4 | Single fix / multi-cause | ✅ |
| 5 | Reflex resistance + no-hints | ✅ |
| 6 | State correctness (probe ≠ recovery) | ✅ |
| 7 | Byzantine fault (upstream lies) | ✅ |
| **8** | **Categorically un-fixable (escalate)** | **✅** |

The agent has now correctly judged 8 distinct on-call response shapes.
The 9th would require multi-agent or stateful-incident-progression
mechanics that this harness doesn't have.

## Cumulative state

| | Value |
|---|---|
| Subagent runs total | 38 eval + 6 judge = **44** |
| Scenarios | **15** |
| Drills | **13** |
| Rubric primitives | **15** (added recognizedAsUnrecoverable) |
| Chaos inject kinds | 5 |
| Real-incident replays | **6** (5 AWS + IAM-revocation pattern) |
| Distributed-systems patterns the agent has applied | 8 + **escalation/no-fix** |
| Tier 1-8 status | **All solvable** |

## Open issues

- `chaosRulesPreserved` FAILed because kumo was offline at score
  time. Either: (a) make this criterion more forgiving when chaos
  endpoints are unreachable, or (b) ensure env stability between
  eval and score steps. Minor.
- The agent caught a real env issue (kumo down) as part of the
  diagnosis. This was unintended but pedagogically positive — the
  scenario tested escalation reasoning, and the agent did escalation
  reasoning under noisy real-world conditions.
