T+5s read: /tmp/wom-eval-schema-1/oncall-pages.txt
T+10s read: /home/user/chaosbringer/examples/aws-chaos-rehearsal/target/src/server.ts
T+15s plan: hypothesis: writeOrder() picks v1 50% of time (no version field). /verify/:id strictly requires row.version===2, so half of placed orders 404. Fix: make /verify backward-compat — accept v1 (no version field) as valid, skip checksum if absent. Do NOT touch write path (deploy-in-progress).
T+20s edit: target/src/server.ts — read-path shim accepting v1 rows.
T+120s restart: killed stale PIDs, restarted target.
T+180s verify: 40/40 place+verify pairs succeeded (100%). v1Reads404=0.
T+185s done: root cause = read-path strictly required version=2, but rolling deploy left ~50% rows as v1.
