T+0s start: on-call rehearsal begins. Page indicates CLOCK_SKEW_MS=30_000 likely unreverted.
T+95s read: /tmp/wom-eval-clock-1/oncall-pages.txt — confirms /__clock shows +30000ms skew.
T+95s read: /home/user/chaosbringer/examples/aws-chaos-rehearsal/target/src/server.ts — found CLOCK_SKEW_MS=30_000 at line 35, used by localNow(), causing 100% rejection vs 5s tolerance.
T+95s plan: hypothesis: the debug-leftover CLOCK_SKEW_MS=30_000 shifts every Date.now() by 30s, exceeding the 5s tolerance. Fix: set CLOCK_SKEW_MS = 0 to revert the debug change. This is the minimal, root-cause-addressing fix.
T+100s edit: server.ts CLOCK_SKEW_MS 30_000 -> 0
T+150s restart: killed stale tsx server pids (1422/1435/1436/1455) and respawned via nohup npx tsx target/src/server.ts. Verified pgrep shows new pids (9792...) and /__clock now returns skewMs=0.
T+170s verify: probed POST /orders x40 — ok=40 fail=0 (100% sustained, well above 80% threshold).
T+175s done: root cause = leftover debug constant CLOCK_SKEW_MS=30_000; mitigation = revert to 0; success rate 100%.
