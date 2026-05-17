# Eval pass: 3 new scenarios (quota / DNS race / cache stampede)

First runs of the three scenarios added per the user's "上から3つ"
request. Each tests a distinct lesson absent from the prior catalog.

## Results

| Scenario | Mitigation chosen | Score | Customer % | Notes |
|---|---|---|---|---|
| quota-saturated | 6-attempt withRetry on all AWS calls | 88% | 96% | `didNotAddRetries` correctly FAIL'd. Outcome OK because chaos doesn't model real quota rate-limiting. |
| ddb-dns-race | 200/250ms timeouts + 20-attempt app retry, 8s deadline | 88% | 96% | Red herring "added throttling-style retry config" tripped — but mitigation IS closer to the scenario's intended path. |
| tier-lookup-stampede | TTL cache (30s) + single-flight, NO retries | **100%** | **100%** | Cleanest run. Agent followed the scenario hint literally: "ADD code." |

## Per-scenario findings

### quota-saturated (88%, customer 96%)

The agent applied the most common reflex: wrap every AWS call in a
6-attempt retry helper. In our chaos model, this works
mathematically — 0.6^6 ≈ 4.7% combined failure, so 95% of customer
requests succeed.

**Fault-model fidelity finding**: a real soft-quota system
(LimitExceededException) rate-limits per account-second; retries
within the same second ALL fail because they share the same budget.
Our `quotaExhaustion` drill is fixed-probability with NO feedback,
so each retry is an independent 60% roll. The agent's wrong-direction
mitigation works in our model but would fail in production.

Rubric still caught it (`didNotAddRetries` FAIL, weight 3). Score
88% = "outcome OK, process wrong."

**Action item for next iteration**: upgrade `quotaExhaustion` to use
feedback chaos (windowMs=1000, threshold=20, probabilityStep=0.05)
so the chaos itself punishes retry storms. Then outcome and process
criteria will agree.

### ddb-dns-race (88%, customer 96%)

The agent did the harder, more authentic thing: read source, noted
that connection-level errors look different from throttling, and
wrote tight per-call timeouts (200ms connect, 250ms request,
`throwOnRequestTimeout`) plus an app-level retry wrapper with an 8s
total deadline.

The mitigation is closer to the scenario's intent. The red herring
"added throttling-style retry config" matched because the agent's
text said `retryMode` and `maxAttempts` near `throttl-` patterns
(false positive from the regex — these were CONFIGURED but not
specifically retry-throttling logic).

Wall clock: 332s — longer than other recent runs. The agent
oscillated through SDK config before reaching the app-level retry
pattern.

### tier-lookup-stampede (100%, customer 100%)

The cleanest run of the three. The agent recognized the cache
stampede shape immediately from:
- chaos rule targeting `GetItem` specifically (not all DDB)
- source code calling `GetCommand` on tier-config every request
- the brief's explicit hint "the mitigation may require ADDING new
  code"

Applied: 30s TTL in-memory cache + single-flight de-duplication. NO
retries. Restart → 40/40 = 100%, chaos rule's `lastApply` froze
(read rate dropped below the 10/sec feedback threshold).

This is the first scenario where the right mitigation is to **add
code**, not remove or decouple. The agent reached for it without
oscillation — the brief's hint was load-bearing.

## Cross-scenario mitigation shape now spans 6 distinct patterns

Updated taxonomy after these 3 runs:

| Direction | Scenarios | Wall clock typical |
|---|---|---|
| Remove gratuitous call | control-plane-degraded, misleading-chaos | ~60s |
| Decouple non-critical | morning-rush-cognito, silent-credit-card-failures | ~90-500s |
| Add durable buffer (WAL) | checkout-receipts-stalled | ~120s |
| **Add cache (NEW)** | **tier-lookup-stampede** | **70s** |
| Bound deadlines + circuit-break | ddb-dns-race | ~330s |
| Reduce call rate (NOT retry) | quota-saturated (in theory; agent didn't) | — |

The 6-direction matrix maps roughly to: subtract, defer, persist,
absorb, bound, throttle.

## Cumulative state after this batch

| | Pre-batch | Post-batch |
|---|---|---|
| Scenarios | 6 | **9** |
| Drills | 5 | **8** (+ quota, dns-race, cache-stampede) |
| Subagent runs total | 17 | **20** |
| Lessons exercised | 5 + 1 adversarial | 7 + 1 adversarial |
| 100% best-of-N count | 5 of 6 | 6 of 9 |

The three new scenarios produced two 88%s and one 100%. Both 88%
runs reflect real rubric findings (anti-pattern detected) even
though outcome recovered. The 100% (tier-lookup-stampede) is the
first scenario where the explicit "add code" hint paid off
immediately.

## Open issues from this batch

1. **`quotaExhaustion` drill needs feedback**. Fixed-probability
   chaos lets retries trivially win. Upgrade with feedback so the
   wrong mitigation is punished by outcome.

2. **`dns-race` red-herring detector is over-broad**. The current
   regex `(retryMode|maxAttempts).*throttl` matched the agent's
   description of WHAT THE SDK DOES (retry-quota throttling) rather
   than what the agent did. Refine to detect agent's own
   configuration intent.

3. **Wall-clock variance is large (54-332s)** across scenarios.
   The new dns-race took 5x longer than tier-lookup-stampede. This
   is real signal — dns-race has many "right-looking" config
   options, while tier-lookup-stampede has one canonical fix.
