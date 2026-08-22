/**
 * FINDING G — `markOrderSensitivePlans` and `expect.state`.
 *
 * Two plans with the same step multiset but different expectations are the
 * definition of an order-dependent verdict, and the runner refuses to replay
 * them. `expectationKey` used to be built from `ui` and `unhandledRejection`
 * only, so two plans that differ *only* in `expect.state` — which is where
 * every server-side observable lives: order counts, refresh counts — were not
 * flagged, got replayed, and one of the two was a coin flip on settlement
 * order. It now serialises every expectation field, and this file asserts it,
 * `expect.calls` included.
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

/** Same multiset, same label, different predicted call count. */
const callsDivergent: FaultPlan[] = [
  { name: "calls-A", schedule: steps(), expect: { ui: "placed", calls: { order: 1 } } },
  { name: "calls-B", schedule: steps(), expect: { ui: "placed", calls: { order: 2 } } },
];

/** Same multiset, same expectation written in a different key order. */
const sameExpectation: FaultPlan[] = [
  { name: "same-A", schedule: steps(), expect: { ui: "placed", state: { orders: 1, tries: 2 } } },
  { name: "same-B", schedule: steps(), expect: { ui: "placed", state: { tries: 2, orders: 1 } } },
];

let failed = 0;
for (const [label, plans, want] of [
  ["ui-divergent (control)", uiDivergent, true],
  ["state-divergent", stateDivergent, true],
  ["calls-divergent", callsDivergent, true],
  ["same expectation, key order", sameExpectation, false],
] as const) {
  const marked = markOrderSensitivePlans(plans);
  const flags = marked.map((p) => p.orderSensitive ?? false);
  const ok = flags.every((f) => f === want);
  if (!ok) failed += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label.padEnd(28)} orderSensitive=${JSON.stringify(flags)} (want ${want})`,
  );
}
if (failed > 0) process.exitCode = 1;
