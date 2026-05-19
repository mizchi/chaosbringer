T+0s read: /tmp/wom-eval-bouncer-1/oncall-pages.txt
T+0s read: /home/user/chaosbringer/examples/aws-chaos-rehearsal/target/src/server.ts
T+30s plan: hypothesis: in-process bouncer semaphore caps concurrency at BOUNCER_MAX=3. Local pg pool max=20 stays idle (waitingCount=0, idleCount high) because the semaphore serializes /orders BEFORE the pool. Each slot holds 0.5s+ (pg_sleep + insert). At concurrency >3 the queue dominates, p99=4-8s. Mitigation: raise BOUNCER_MAX significantly (e.g., 20 to match pool.max). Not touching /health.
T+45s edit: target/src/server.ts BOUNCER_MAX 3 -> 20
T+90s verify: /__bouncer max=20 confirmed; pool unchanged.
T+120s test: N=40 C=10 -> 40/40 (100%) p50=0.51s p99=0.55s wall=2.08s. FIXED.
