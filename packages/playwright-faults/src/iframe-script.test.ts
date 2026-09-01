import { describe, expect, it } from "vitest";
import { buildIframeFaultsScript } from "./iframe-faults.js";
import type { IframeFault } from "./types.js";

/**
 * The iframe layer was the odd one out. Its in-page loop was single-pass — the
 * first fault to claim an iframe returned — so a *scheduled* fault sitting
 * behind a claiming one never advanced its occurrence and therefore never
 * fired. `decisions: ["pass", "inject"]` on the second rule meant something
 * different here than on the network and runtime layers, silently, while
 * `schedule.ts` promised "the same shape is understood by all four layers".
 *
 * The script is a self-contained IIFE over `window` and `HTMLIFrameElement`, so
 * `new Function` with stubs runs the real thing.
 */
interface FakeIframe {
  matches(selector: string): boolean;
  src: string;
  remove(): void;
}

function install(faults: IframeFault[], seed = 1) {
  const assigned: string[] = [];
  const realSrcSetter = function (this: FakeIframe, v: string) {
    assigned.push(v);
  };
  // Minimal HTMLIFrameElement.prototype with a configurable `src` accessor and
  // a `setAttribute`, which is all the patch needs.
  const proto = {
    setAttribute(this: FakeIframe, name: string, value: string) {
      if (name === "src") this.src = value;
    },
  };
  Object.defineProperty(proto, "src", {
    configurable: true,
    enumerable: true,
    get(this: FakeIframe) {
      return "";
    },
    set: realSrcSetter,
  });
  const HTMLIFrameElement = function () {} as unknown as { prototype: object };
  HTMLIFrameElement.prototype = proto;

  const win: Record<string, unknown> = {};
  const script = buildIframeFaultsScript(faults, seed);
  new Function("window", "HTMLIFrameElement", "document", script)(win, HTMLIFrameElement, {});

  const make = (selector: string): FakeIframe =>
    Object.create(proto, {
      matches: { value: (s: string) => s === selector },
      remove: { value: () => {} },
    }) as FakeIframe;

  const stats = () =>
    win.__chaosbringerIframeFaultStats as Record<
      string,
      { matched: number; fired: number; suppressed: number }
    >;
  return { make, assigned, stats };
}

const neverLoad = (over: Partial<IframeFault>): IframeFault => ({
  selector: "iframe",
  action: { kind: "never-load" },
  ...over,
});

describe("the generated iframe script", () => {
  it("advances a scheduled fault behind a claiming one, so occurrence 1 means what it says", () => {
    // `first` claims occurrence 0; `second` must still count it, so its own
    // `decisions[1]` lands on the *second* iframe. Single-pass, `second` never
    // saw the first assignment and its inject never fired.
    const { make, stats } = install([
      neverLoad({ name: "first", schedule: { decisions: ["inject", "pass"] } }),
      neverLoad({ name: "second", schedule: { decisions: ["pass", "inject"] } }),
    ]);
    make("iframe").src = "https://a.example/";
    make("iframe").src = "https://b.example/";

    expect(stats()["0"]).toEqual({ matched: 2, fired: 1, suppressed: 0 });
    expect(stats()["1"]).toEqual({ matched: 2, fired: 1, suppressed: 0 });
  });

  it("records the decision it could not act on rather than dropping it", () => {
    const { make, stats } = install([
      neverLoad({ name: "winner", schedule: { decisions: ["inject"] } }),
      neverLoad({ name: "loser", schedule: { decisions: ["inject"] } }),
    ]);
    make("iframe").src = "https://a.example/";
    expect(stats()["0"]).toEqual({ matched: 1, fired: 1, suppressed: 0 });
    // Occurrence advanced, decision was "inject", nothing acted.
    expect(stats()["1"]).toEqual({ matched: 1, fired: 0, suppressed: 1 });
  });

  it("does not count an iframe whose selector does not match", () => {
    const { make, stats } = install([
      neverLoad({ name: "ads-only", selector: ".ad", schedule: { decisions: ["inject"] } }),
    ]);
    make("iframe").src = "https://a.example/";
    expect(stats()["0"]).toEqual({ matched: 0, fired: 0, suppressed: 0 });
  });

  it("still claims the assignment when a fault fires, and passes it through when none does", () => {
    // The guard against "made everything advance and broke the actual effect".
    const firing = install([neverLoad({ name: "f", schedule: { decisions: ["inject"] } })]);
    firing.make("iframe").src = "https://a.example/";
    expect(firing.assigned).toEqual(["about:blank"]);

    const passing = install([neverLoad({ name: "f", schedule: { decisions: ["pass"] } })]);
    passing.make("iframe").src = "https://a.example/";
    expect(passing.assigned).toEqual(["https://a.example/"]);
  });

  it("keeps probability lazy, so adding a rule behind a firing one does not shift the seed", () => {
    // The probability path must NOT be consulted once a winner exists — that is
    // what keeps existing seeded configs drawing the same numbers.
    const { make, stats } = install([
      neverLoad({ name: "always", probability: 1 }),
      neverLoad({ name: "behind", probability: 0.5 }),
    ]);
    make("iframe").src = "https://a.example/";
    expect(stats()["0"]).toEqual({ matched: 1, fired: 1, suppressed: 0 });
    expect(stats()["1"]).toEqual({ matched: 0, fired: 0, suppressed: 0 });
  });
});
