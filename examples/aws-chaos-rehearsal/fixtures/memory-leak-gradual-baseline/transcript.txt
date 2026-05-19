T+30s read: pages confirm RSS+heap climbing, GC pause 220ms, colleague hint /__mem retainedRequests
T+30s inspect: /kumo/chaos/rules empty, stats empty -> no external chaos
T+30s rootcause: server.ts has unbounded `recentRequests` Map; each /orders + /health appends 256KB Buffer, never evicted. Payload unused after response.
T+45s plan: remove the retention entirely (data is unused). Restart target.
T+120s edit: bounded recentRequests LRU to 64 entries, dropped payload from 256KB to 16B (unused).
T+150s restart: killed old PIDs (pkill missed because pattern matched current shell args), relaunched tsx target.
T+170s verify: /__mem retainedRequests=20 then stable at 64 under load; RSS ~100MB stable.
T+200s loadtest: 40/40 /orders 200 OK. 100% success rate over 40 samples (>=80% threshold met).
T+200s rootcause: unbounded Map<string,{ts,payload:Buffer(256KB)}> in writeOrder() with no eviction. Heap grew linearly with requests, GC pause climbed proportionally => p99 latency degraded.
