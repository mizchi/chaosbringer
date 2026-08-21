/**
 * W — is each pattern's observation window actually longer than that pattern's
 * own retries and backoffs?
 *
 *   cd examples/model-faults && npx tsx patterns-audit/windows.mts
 *
 * No browser: the bridges' declared or solved windows against the app-side
 * constants read out of the pages themselves. A window that only just fits is
 * a flake waiting for a slower runner, and the slack is the number to look at.
 */
import { readFileSync } from "node:fs";
import { resolvePlanTiming } from "chaosbringer";
import optimistic from "../patterns/optimistic-rollback/bridge.mjs";
import pagination from "../patterns/pagination-order/bridge.mjs";
import reconnect from "../patterns/reconnect-budget/bridge.mjs";
import retry from "../patterns/retry-idempotency/bridge.mjs";
import timeout from "../patterns/timeout-ladder/bridge.mjs";
import token from "../patterns/token-refresh/bridge.mjs";

function page(file: string): string {
  return readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
}

function solved(b: { appDeadlineMs?: number; timingProfile?: unknown }) {
  return resolvePlanTiming({ appDeadlineMs: b.appDeadlineMs!, timingProfile: b.timingProfile as never });
}

const rows: Array<[string, string, string]> = [];

rows.push([
  "retry-idempotency",
  `settleMs=${(retry as { settleMs: number }).settleMs} declared, quiescenceMs defaults to settleMs`,
  `app: 2 attempts + ${/BACKOFF_MS = (\d+)/.exec(page("retry.js"))![1]}ms backoff`,
]);
rows.push([
  "token-refresh",
  `settleMs=${(token as { settleMs: number }).settleMs} declared`,
  "app: 2x 401 + 80ms server-side refresh latency + 2 replays",
]);
rows.push([
  "optimistic-rollback",
  `settleMs=${(optimistic as { settleMs: number }).settleMs} declared`,
  "app: 1 POST + 1 reconcile GET, no backoff",
]);
{
  const t = solved(timeout as never);
  rows.push([
    "timeout-ladder",
    `settleMs=${t.settleMs} solved, slow-trip=${t.delays!.slowMs}, slow-ok=${t.delays!.fastMs}`,
    `app deadline ${/DEADLINE_MS = (\d+)/.exec(page("slow.js"))![1]}ms; ` +
      `slow-trip lands ${t.delays!.slowMs - t.settleMs}ms after the probe`,
  ]);
}
{
  const t = solved(pagination as never);
  rows.push([
    "pagination-order",
    `settleMs=${t.settleMs} solved, slow-ok=${t.delays!.fastMs}`,
    `app deadline ${/DEADLINE_MS = (\d+)/.exec(page("feed.js"))![1]}ms; ` +
      `slow page 1 lands ${t.settleMs - t.delays!.fastMs}ms before the probe`,
  ]);
}
{
  const t = solved(reconnect as never);
  const backoffs = /BACKOFF_MS = \[([\d, ]+)\]/.exec(page("stream.js"))![1]!;
  const sum = backoffs.split(",").reduce((n, x) => n + Number(x), 0);
  rows.push([
    "reconnect-budget",
    `settleMs=${t.settleMs} solved`,
    `app: 3 attempts + backoffs [${backoffs}] = ${sum}ms of waiting; ` +
      `slack ${t.settleMs - sum}ms (and each attempt's own deadline is ` +
      `${/DEADLINE_MS = (\d+)/.exec(page("stream.js"))![1]}ms)`,
  ]);
}

for (const [name, window, app] of rows) {
  console.log(`  ${name.padEnd(20)} ${window}\n  ${" ".repeat(20)} ${app}`);
}
