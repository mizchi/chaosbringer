# Demo: why the curl probe and the journey probe disagree

`scripts/demo.sh` runs a Byzantine fault (kumo returns 200 OK on
PutItem without persisting the row) and shows the two customer-impact
probes side by side. Same target, same chaos. The curl probe sees
nothing wrong. The journey probe catches every failure.

This is the harness's signature moment — the curl-shaped probe pattern
that production teams typically reach for is **structurally blind** to
this class of failure. The journey-based probe is not.

## Run it

```sh
./scripts/bootstrap.sh        # idempotent env setup (kumo + proxies + AWS resources)
./scripts/demo.sh
```

No API key required. The agent layer is bypassed entirely — the demo
is about observability, not recovery.

## Expected output

```
▶ Verify env is up (run scripts/bootstrap.sh if anything is missing)
  kumo healthy

▶ Stop any stale targets, install the silent-data-loss baseline
  target (silent-loss) running on http://localhost:3000

▶ Install Byzantine chaos: 100% silentSuccess on DDB PutItem
  kumo will return 200 OK without persisting. Customer sees success; row never lands.
  chaos installed

▶ Mode 1 — curl probe (the legacy probe; sees only HTTP status)
  ● curl: 10/10 ok (HTTP 200), 0 fail
  → verdict: customer service is HEALTHY. Page would be downgraded.

▶ Mode 2 — chaosbringer SPA journey (clicks Place Order, then verifies the row exists)
  ● journey: 0/2 ok, 2 fail
  → verdict: every order is MISSING from the store. Page would stay P1.

▶ Trace forensics — every failed iteration's traceparent appears in kumo's per-rule ring buffer
  iterations recorded by SPA: 2
    outcome=found:          0 (expected to NOT be in kumo's chaos ring)
    outcome=verify-missing: 2 (expected to ALL be in kumo's chaos ring)
  verify-missing iterations whose trace IS in kumo recentTraces: 2/2
  → per-iteration attribution is exact: every customer failure can be traced back to the chaos rule that caused it.

▶ Cleanup
  demo complete
```

## What's happening

1. **Setup.** A `silentSuccess` chaos rule is installed on
   `dynamodb:PutItem` at the kumo layer. When matched, kumo returns
   a protocol-correct 200 OK *without invoking the actual handler*
   — the row is never written. The application's SDK call returns
   success, the HTTP response body has a fresh order id, everything
   looks fine.

2. **Mode 1 (curl probe).** 10 `POST /orders` requests. Every one
   returns 200 because the application's view of the world is that
   the write succeeded. The standard "POST returns 2xx → service is
   healthy" probe would silently report a green dashboard while
   every customer order quietly vanishes.

3. **Mode 2 (journey probe).** The SPA's click handler does TWO
   fetches per iteration:
   - `POST /orders` → returns the id (200, looks fine)
   - `GET /verify/:id` → asks the variant to confirm the row is in
     DDB. The silent-loss variant calls `GetItem` against the just-
     placed id. Under silentSuccess chaos the GetItem returns
     `Item: undefined`, so /verify/:id returns 404, and the SPA's
     status element switches to `data-state=missing`. The recipe's
     postcondition (`data-state=found`) fails. The journey records
     the failure.

4. **Trace forensics.** Every SPA click generates a fresh W3C
   `traceparent` (#115). The target propagates it through the AWS
   SDK to kumo, where the chaos engine records it in a per-rule
   ring buffer. The SPA also POSTs the trace + outcome to a
   target-side `/__trace` endpoint. After the journey, scoring
   joins these two views — and finds that every `verify-missing`
   iteration's trace is in kumo's chaos-rule ring buffer, 1:1.

## What this tells you about your own system

If you're operating an HTTP/JSON write path that:

- Has a synchronous external write (DDB, RDS, S3, …)
- Uses status-code-only health probes
- Has no journey-style invariant check after the write

…then a Byzantine upstream (kumo's silentSuccess kind; in production:
a misconfigured replica, a serialization-rejection bug, a write that
times out client-side but commits server-side, an idempotency token
collision) will show up exactly like this demo: customer-visible 2xx,
no alerts, and the data slowly diverges from the source of truth.

The fix the silent-data-loss scenario rubric rewards is read-after-
write verification or a write-ahead-with-confirm pattern. The
journey-based probe is the regression guard that catches a future
similar bug before customer service does.

## Going deeper

After watching the demo, run a real scenario end-to-end:

```sh
cd examples/aws-chaos-rehearsal
pnpm prepare silent-data-loss my-run-1
# paste the brief into your agent (Claude Code / claude -p / your sweep driver)
pnpm score silent-data-loss my-run-1
```

The score's debrief includes the same trace-forensics section plus a
process-over-outcome rubric verdict on the agent's mitigation.
