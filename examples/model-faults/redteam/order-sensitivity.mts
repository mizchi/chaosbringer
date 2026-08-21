/**
 * FINDING G — `markOrderSensitivePlans` ignores `expect.state`.
 *
 * Two plans with the same step multiset but different expectations are the
 * definition of an order-dependent verdict, and the runner refuses to replay
 * them. But `expectationKey` is built from `ui` and `unhandledRejection`
 * only (plan.ts), so two plans that differ *only* in `expect.state` — which
 * is where every server-side observable lives: order counts, refresh counts —
 * are not flagged, get replayed, and one of the two is a coin flip on
 * settlement order.
 */
import { markOrderSensitivePlans, type FaultPlan } from "chaosbringer";

const steps = (): FaultPlan["schedule"] => [
  { order: 0, rule: "order", outcome: "reject-body", occurrence: 0 },
  { order: 1, rule: "refresh", outcome: "pass", occurrence: 0 },
];

/** Same multiset, different UI label — the case the guard was written for. */
const uiDivergent: FaultPlan[] = [
  { name: "ui-A", schedule: steps(), expect: { ui: "placed" } },
  { name: "ui-B", schedule: steps(), expect: { ui: "error" } },
];

/** Same multiset, same label, different server-side outcome. */
const stateDivergent: FaultPlan[] = [
  { name: "state-A", schedule: steps(), expect: { ui: "placed", state: { orders: 1 } } },
  { name: "state-B", schedule: steps(), expect: { ui: "placed", state: { orders: 2 } } },
];

for (const [label, plans] of [
  ["ui-divergent (control)", uiDivergent],
  ["state-divergent", stateDivergent],
] as const) {
  const marked = markOrderSensitivePlans(plans);
  console.log(
    `${label.padEnd(24)} orderSensitive=${JSON.stringify(marked.map((p) => p.orderSensitive ?? false))}`,
  );
}
