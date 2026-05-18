/**
 * tcp-chaos-proxy.ts — TCP-level fault injector for sub-AWS-SDK
 * chaos (#119 Gap 3, network layer).
 *
 * Sits between the target and kumo:
 *
 *   target  ->  tcp-chaos-proxy :14566  ->  kumo :4566
 *
 * Target points AWS_ENDPOINT_URL at the proxy. The proxy normally
 * forwards every connection straight to kumo; when a chaos rule is
 * installed, some fraction of new connections are refused or held
 * before forward — simulating DNS storms, intermittent
 * connectivity, or a "cross-AZ partition" where one upstream is
 * unreachable.
 *
 * Why this is separate from kumo's own `disconnect` inject:
 *   - kumo.disconnect: connection establishes to kumo, request body
 *     is received server-side, then kumo tears the connection down.
 *     The PutItem may have committed.
 *   - tcp-chaos connect-refuse: the connection NEVER REACHES kumo.
 *     The client sees ECONNREFUSED / ETIMEDOUT at connect time. No
 *     server-side state is touched.
 *
 * Admin surface (HTTP on TCP_ADMIN_PORT, default 14567):
 *   POST /tcp-chaos/rules        — install a rule
 *   DELETE /tcp-chaos/rules      — clear all rules
 *   GET /tcp-chaos/rules         — list rules + stats
 *   GET /tcp-chaos/stats         — stats only (matches kumo shape)
 *
 * Rule shape:
 *   {
 *     "id": "...",
 *     "enabled": true,
 *     "inject": { "kind": "connect-refuse", "probability": 0.3 }
 *   }
 *   {
 *     "id": "...",
 *     "enabled": true,
 *     "inject": { "kind": "partition", "durationMs": 5000 }
 *   }
 *
 * The partition kind drops ALL new connections for durationMs after
 * install — a hard outage burst, distinct from connect-refuse's
 * probabilistic flapping.
 */
import { createServer as createTcpServer, connect as tcpConnect } from "node:net";
import { createServer as createHttpServer } from "node:http";

interface Rule {
  id: string;
  enabled: boolean;
  inject: ConnectRefuseInject | PartitionInject;
}
interface ConnectRefuseInject {
  kind: "connect-refuse";
  probability: number;
}
interface PartitionInject {
  kind: "partition";
  durationMs: number;
}

interface RuleEntry {
  rule: Rule;
  installedAt: number;
  matched: number;
}

const upstreamHost = process.env.TCP_PROXY_UPSTREAM_HOST ?? "localhost";
const upstreamPort = Number(process.env.TCP_PROXY_UPSTREAM_PORT ?? 4566);
const proxyPort = Number(process.env.TCP_PROXY_PORT ?? 14566);
const adminPort = Number(process.env.TCP_ADMIN_PORT ?? 14567);

const rules: RuleEntry[] = [];

function pickInject(): RuleEntry["rule"]["inject"] | null {
  const now = Date.now();
  for (const entry of rules) {
    if (!entry.rule.enabled) continue;
    if (entry.rule.inject.kind === "partition") {
      if (now - entry.installedAt < entry.rule.inject.durationMs) {
        entry.matched++;
        return entry.rule.inject;
      }
      continue;
    }
    if (entry.rule.inject.kind === "connect-refuse") {
      if (Math.random() < entry.rule.inject.probability) {
        entry.matched++;
        return entry.rule.inject;
      }
    }
  }
  return null;
}

const tcpServer = createTcpServer((client) => {
  const inject = pickInject();
  if (inject) {
    client.destroy();
    return;
  }
  const upstream = tcpConnect({ host: upstreamHost, port: upstreamPort });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.pipe(upstream).pipe(client);
});
tcpServer.listen(proxyPort, () => {
  console.error(
    `[tcp-chaos-proxy] tcp :${proxyPort} -> ${upstreamHost}:${upstreamPort}, admin :${adminPort}`,
  );
});

const adminServer = createHttpServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "/";
  if (req.method === "POST" && url === "/tcp-chaos/rules") {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        const rule = JSON.parse(buf) as Rule;
        if (!rule.id) return send(400, { error: "id required" });
        const idx = rules.findIndex((e) => e.rule.id === rule.id);
        const entry: RuleEntry = { rule, installedAt: Date.now(), matched: 0 };
        if (idx >= 0) rules[idx] = entry;
        else rules.push(entry);
        send(200, { id: rule.id, status: "installed" });
      } catch (err) {
        send(400, { error: String(err) });
      }
    });
    return;
  }
  if (req.method === "DELETE" && url === "/tcp-chaos/rules") {
    rules.length = 0;
    return send(200, { status: "cleared" });
  }
  if (req.method === "GET" && url === "/tcp-chaos/rules") {
    return send(200, {
      rules: rules.map((e) => e.rule),
      stats: rules.map((e) => ({ ruleId: e.rule.id, matched: e.matched, installedAt: e.installedAt })),
    });
  }
  if (req.method === "GET" && url === "/tcp-chaos/stats") {
    return send(200, rules.map((e) => ({ ruleId: e.rule.id, matched: e.matched, installedAt: e.installedAt })));
  }
  send(404, { error: "unknown route" });
});
adminServer.listen(adminPort);
