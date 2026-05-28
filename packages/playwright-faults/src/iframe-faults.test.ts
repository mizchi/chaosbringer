import { describe, expect, it } from "vitest";
import {
  buildIframeFaultsScript,
  compileIframeFaults,
  iframeFaultName,
  mergeIframeStats,
} from "./iframe-faults.js";
import type { IframeFault } from "./types.js";

describe("iframeFaultName", () => {
  it("uses an explicit name when set", () => {
    expect(
      iframeFaultName({
        name: "ad-slot-fault",
        selector: "iframe",
        action: { kind: "never-load" },
      }),
    ).toBe("ad-slot-fault");
  });

  it("auto-derives a name for load-delay including the delay", () => {
    expect(
      iframeFaultName({ selector: "iframe", action: { kind: "load-delay", ms: 3000 } }),
    ).toBe("iframe-load-delay:3000ms");
  });

  it("auto-derives a name for never-load", () => {
    expect(
      iframeFaultName({ selector: "iframe", action: { kind: "never-load" } }),
    ).toBe("iframe-never-load");
  });

  it("auto-derives a name for remove-mid-load including atMs", () => {
    expect(
      iframeFaultName({
        selector: "iframe",
        action: { kind: "remove-mid-load", atMs: 500 },
      }),
    ).toBe("iframe-remove-mid-load:500ms");
  });
});

describe("compileIframeFaults", () => {
  it("returns empty array for empty input", () => {
    expect(compileIframeFaults(undefined)).toEqual([]);
    expect(compileIframeFaults([])).toEqual([]);
  });

  it("initialises matched / fired counters at 0", () => {
    const compiled = compileIframeFaults([
      { selector: "iframe", action: { kind: "never-load" } },
    ]);
    expect(compiled[0]!.matched).toBe(0);
    expect(compiled[0]!.fired).toBe(0);
    expect(compiled[0]!.name).toBe("iframe-never-load");
  });

  it("carries the fault object through unchanged", () => {
    const fault: IframeFault = {
      selector: "#slot iframe",
      action: { kind: "load-delay", ms: 1000 },
      probability: 0.5,
    };
    const compiled = compileIframeFaults([fault]);
    expect(compiled[0]!.fault).toBe(fault);
  });
});

describe("buildIframeFaultsScript", () => {
  it("returns a non-empty IIFE wrapped in (() => { ... })()", () => {
    const script = buildIframeFaultsScript(
      [{ selector: "iframe", action: { kind: "never-load" } }],
      42,
    );
    expect(script.startsWith("(() => {")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
    expect(script).toContain("HTMLIFrameElement");
    expect(script).toContain("__chaosbringerIframeFaultStats");
  });

  it("inlines the selector and action so the in-page script needs no eval", () => {
    const script = buildIframeFaultsScript(
      [
        {
          selector: "iframe[data-widget='player']",
          action: { kind: "load-delay", ms: 2500 },
        },
      ],
      1,
    );
    expect(script).toContain("iframe[data-widget='player']");
    expect(script).toContain('"load-delay"');
    expect(script).toContain("2500");
  });

  it("threads the seed through so identical seeds produce identical scripts", () => {
    const a = buildIframeFaultsScript(
      [{ selector: "iframe", action: { kind: "never-load" } }],
      42,
    );
    const b = buildIframeFaultsScript(
      [{ selector: "iframe", action: { kind: "never-load" } }],
      42,
    );
    expect(a).toBe(b);
  });

  it("emits a guard against double-installation", () => {
    const script = buildIframeFaultsScript([], 0);
    expect(script).toContain("__chaosbringerIframeFaultsInstalled");
  });
});

describe("mergeIframeStats", () => {
  it("aggregates page stats into the compiled-fault counters by index", () => {
    const compiled = compileIframeFaults([
      { selector: "iframe.a", action: { kind: "never-load" } },
      { selector: "iframe.b", action: { kind: "load-delay", ms: 100 } },
    ]);

    mergeIframeStats(compiled, {
      "0": { matched: 3, fired: 2 },
      "1": { matched: 1, fired: 1 },
    });

    expect(compiled[0]!.matched).toBe(3);
    expect(compiled[0]!.fired).toBe(2);
    expect(compiled[1]!.matched).toBe(1);
    expect(compiled[1]!.fired).toBe(1);
  });

  it("accumulates across multiple merges (so multi-page crawls add up)", () => {
    const compiled = compileIframeFaults([
      { selector: "iframe", action: { kind: "never-load" } },
    ]);

    mergeIframeStats(compiled, { "0": { matched: 2, fired: 1 } });
    mergeIframeStats(compiled, { "0": { matched: 3, fired: 2 } });

    expect(compiled[0]!.matched).toBe(5);
    expect(compiled[0]!.fired).toBe(3);
  });

  it("returns stats with rule / selector / action / matched / fired shape", () => {
    const compiled = compileIframeFaults([
      {
        name: "ads-3s",
        selector: "iframe.ad",
        action: { kind: "load-delay", ms: 3000 },
      },
    ]);

    const stats = mergeIframeStats(compiled, { "0": { matched: 4, fired: 2 } });

    expect(stats).toEqual([
      {
        rule: "ads-3s",
        selector: "iframe.ad",
        action: "load-delay",
        matched: 4,
        fired: 2,
      },
    ]);
  });

  it("ignores stat slots with no corresponding compiled fault", () => {
    const compiled = compileIframeFaults([
      { selector: "iframe", action: { kind: "never-load" } },
    ]);
    // Should not throw or affect counters.
    mergeIframeStats(compiled, { "1": { matched: 99, fired: 99 } });
    expect(compiled[0]!.matched).toBe(0);
    expect(compiled[0]!.fired).toBe(0);
  });
});
