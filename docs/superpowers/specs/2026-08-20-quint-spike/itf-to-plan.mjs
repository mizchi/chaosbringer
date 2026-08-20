// ITF (Quint counterexample) -> deterministic chaosbringer fault schedule.
// Pure, ~40 lines: the trace's per-step log entries become an ordered plan of
// per-request outcomes, and the final state becomes the assertion oracle.
import { readFileSync, readdirSync } from "node:fs";

const OUTCOME = { fulfil: "pass", reject: "reject", hang: "hang" };

export function itfToPlan(itf, name) {
  const states = itf.states;
  const last = states[states.length - 1];
  const log = last.log ?? [];
  const steps = log
    .filter((e) => e.kind !== "start")
    .map((e, i) => ({
      order: i,
      // "op" is the fault-rule id; in a real spec it is a URL pattern key.
      rule: e.op,
      outcome: OUTCOME[e.kind],
    }));
  return {
    name,
    // replayed verbatim by the runner: no probability, no seed luck
    schedule: steps,
    expect: { ui: last.ui, unhandledRejection: last.unhandled },
    modelSteps: states.length - 1,
  };
}

const dir = new URL("./traces/", import.meta.url);
const plans = readdirSync(dir)
  .filter((f) => f.endsWith(".itf.json"))
  .map((f) => itfToPlan(JSON.parse(readFileSync(new URL(f, dir), "utf8")), f.replace(".itf.json", "")));
console.log(JSON.stringify(plans, null, 1));
