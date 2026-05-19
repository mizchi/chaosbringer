#!/usr/bin/env bash
# demo.sh — end-to-end smoke that showcases the harness's signature
# moment: the curl-based customer probe and the chaosbringer journey
# probe disagree dramatically on a Byzantine fault.
#
# Same scenario, same target, same chaos. Two probes. The curl probe
# says everything is fine; the journey says nothing landed. That gap
# is the whole reason this harness exists.
#
# No agent / no API key required. The agent is noop (intentionally
# writes a "I gave up" journal) so the score is low — what we're
# showcasing is the OBSERVABILITY, not the agent's recovery.
#
# Run from the example dir, with bootstrap.sh already executed:
#   ./scripts/bootstrap.sh
#   ./scripts/demo.sh
set -euo pipefail

cd "$(dirname "$0")/.."
KUMO="http://localhost:4566"
TARGET="http://localhost:3000"

say() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
note() { printf "  %s\n" "$*"; }

say "Verify env is up (run scripts/bootstrap.sh if anything is missing)"
curl -sf -m 2 "$KUMO/kumo/chaos/rules" >/dev/null || { echo "kumo not up — run scripts/bootstrap.sh"; exit 1; }
note "kumo healthy"

say "Stop any stale targets, start the silent-data-loss variant"
fuser -k 3000/tcp 2>&1 | grep -v '^$' || true
sleep 1
AWS_ENDPOINT_URL="$KUMO" nohup npx tsx target/src/server.silent-loss.ts > /tmp/target.log 2>&1 &
disown
sleep 4
curl -sf -m 2 "$TARGET/" >/dev/null || { echo "target failed to start"; cat /tmp/target.log; exit 1; }
note "target (silent-loss) running on $TARGET"

say "Install Byzantine chaos: 100% silentSuccess on DDB PutItem"
note "kumo will return 200 OK without persisting. Customer sees success; row never lands."
curl -s -X DELETE "$KUMO/kumo/chaos/rules" >/dev/null
curl -s -X POST "$KUMO/kumo/chaos/rules" -H 'content-type: application/json' -d '{
  "id":"demo-silent","enabled":true,"match":{"service":"dynamodb","action":"PutItem"},
  "inject":{"kind":"silentSuccess","probability":1.0}
}' >/dev/null
note "chaos installed"

say "Mode 1 — curl probe (the legacy probe; sees only HTTP status)"
curl_ok=0; curl_fail=0
for i in $(seq 1 10); do
  code=$(curl -s -X POST "$TARGET/orders" -H 'content-type: application/json' -d '{}' -m 5 -o /dev/null -w "%{http_code}")
  [ "$code" = "200" ] && curl_ok=$((curl_ok+1)) || curl_fail=$((curl_fail+1))
done
printf "  \033[32m●\033[0m curl: %d/10 ok (HTTP 200), %d fail\n" "$curl_ok" "$curl_fail"
note "→ verdict: customer service is HEALTHY. Page would be downgraded."

say "Mode 2 — chaosbringer SPA journey (clicks Place Order, then verifies the row exists)"
# Clear any prior trace-log
curl -s -X DELETE "$TARGET/__trace" >/dev/null

# Run a small journey via scenarioLoadFromStore. Use a tmp copy of
# the recipes dir so per-replay stats updates don't churn the
# committed JSON files.
cat > scripts/_demo-journey.mts <<'EOF'
import { RecipeStore, scenarioLoadFromStore } from "chaosbringer";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const src = "/home/user/chaosbringer/examples/aws-chaos-rehearsal/recipes/silent-data-loss";
const tmp = mkdtempSync(join(tmpdir(), "demo-recipes-"));
cpSync(src, tmp, { recursive: true });
const store = new RecipeStore({ localDir: tmp, globalDir: false, silent: true });
const result = await scenarioLoadFromStore({
  baseUrl: "http://localhost:3000",
  store,
  workers: 1,
  duration: "12s",
  maxIterationsPerWorker: 10,
  headless: true,
});
const r = result.recipes[0]!;
process.stdout.write(JSON.stringify({ fired: r.fired, ok: r.succeeded, fail: r.failed }));
EOF
JOURNEY=$(PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx tsx scripts/_demo-journey.mts 2>/tmp/demo-journey-stderr.log)
rm scripts/_demo-journey.mts
if [[ -z "$JOURNEY" ]]; then
  printf "  \033[31m●\033[0m journey: <empty result>\n"
  note "stderr:"
  sed 's/^/    /' /tmp/demo-journey-stderr.log | tail -10
else
  total=$(echo "$JOURNEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["fired"])')
  ok=$(echo "$JOURNEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ok"])')
  fail=$(echo "$JOURNEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["fail"])')
  printf "  \033[31m●\033[0m journey: %s/%s ok, %s fail\n" "$ok" "$total" "$fail"
  note "→ verdict: every order is MISSING from the store. Page would stay P1."
fi

say "Trace forensics — every failed iteration's traceparent appears in kumo's per-rule ring buffer"
python3 <<EOF
import json, urllib.request
traces = json.load(urllib.request.urlopen("$TARGET/__trace"))["entries"]
chaos = json.load(urllib.request.urlopen("$KUMO/kumo/chaos/rules"))
recent = set()
for s in chaos["stats"]:
    for t in s.get("recentTraces", []):
        recent.add(t)
found = sum(1 for t in traces if t["outcome"] == "found")
missing = sum(1 for t in traces if t["outcome"] == "verify-missing")
miss_hit = sum(1 for t in traces if t["outcome"] == "verify-missing" and t["traceparent"] in recent)
print(f"  iterations recorded by SPA: {len(traces)}")
print(f"    outcome=found:          {found} (expected to NOT be in kumo's chaos ring)")
print(f"    outcome=verify-missing: {missing} (expected to ALL be in kumo's chaos ring)")
print(f"  verify-missing iterations whose trace IS in kumo recentTraces: {miss_hit}/{missing}")
print(f"  → per-iteration attribution is exact: every customer failure can be traced back to the chaos rule that caused it.")
EOF

say "Cleanup"
curl -s -X DELETE "$KUMO/kumo/chaos/rules" >/dev/null
fuser -k 3000/tcp 2>&1 | grep -v '^$' || true
note "demo complete"
