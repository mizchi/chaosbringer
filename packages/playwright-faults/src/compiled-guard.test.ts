import { describe, expect, it } from "vitest";
import { compileIframeFaults, mergeIframeStats } from "./iframe-faults.js";
import { compileLifecycleFaults, lifecycleStatsFrom } from "./lifecycle-faults.js";
import { compileRuntimeFaults, mergeRuntimeStats } from "./runtime-faults.js";

/**
 * The stats readers take *compiled* faults. Handed the originals — an easy slip,
 * since both are "the faults" from the caller's side — each produced garbage
 * rather than an error, and the runtime one was the worst: a row labelled with
 * the raw fault's own `name` and counters of `NaN`, which reads as "the fault
 * never fired" in the one assertion the whole harness rests on.
 */
describe("the stats readers refuse raw faults", () => {
  it("runtime: names the compile step instead of returning NaN counters", () => {
    const raw = [{ name: "f1", urlPattern: /x/, action: { kind: "reject-fetch" } }] as const;
    expect(() => mergeRuntimeStats(raw as never, { "0": { matched: 3, fired: 1 } })).toThrow(
      /compileRuntimeFaults/,
    );
  });

  it("lifecycle: names it instead of returning an empty object", () => {
    const raw = [{ when: "afterLoad", action: { kind: "clear-storage", scopes: ["localStorage"] } }];
    expect(() => lifecycleStatsFrom(raw as never)).toThrow(/compileLifecycleFaults/);
  });

  it("iframe: names it instead of a `reading 'selector'` TypeError", () => {
    const raw = [{ name: "i1", selector: "iframe", action: { kind: "never-load" } }];
    expect(() => mergeIframeStats(raw as never, { "0": { matched: 2, fired: 1 } })).toThrow(
      /compileIframeFaults/,
    );
  });

  it("says which index, and that the counters would have lied", () => {
    const raw = [
      { name: "ok", urlPattern: /a/, action: { kind: "reject-fetch" } },
      { name: "also-raw", urlPattern: /b/, action: { kind: "flaky-fetch" } },
    ];
    // The first element is raw too, so index 0 is what it names — the point is
    // that the message carries an index at all.
    expect(() => mergeRuntimeStats(raw as never, {})).toThrow(/index 0/);
    expect(() => mergeRuntimeStats(raw as never, {})).toThrow(/never fired/);
  });

  it("still accepts the compiled shape, so the guard is not just a wall", () => {
    const runtime = compileRuntimeFaults([
      { name: "f1", urlPattern: /x/, action: { kind: "reject-fetch" } },
    ]);
    expect(mergeRuntimeStats(runtime, { "0": { matched: 3, fired: 1 } })).toEqual([
      { rule: "f1", matched: 3, fired: 1 },
    ]);

    const lifecycle = compileLifecycleFaults([
      { when: "afterLoad", action: { kind: "clear-storage", scopes: ["localStorage"] } },
    ]);
    expect(lifecycleStatsFrom(lifecycle)).toEqual([
      { name: "clear-storage:localStorage", matched: 0, fired: 0, errored: 0 },
    ]);

    const iframe = compileIframeFaults([
      { name: "i1", selector: "iframe", action: { kind: "never-load" } },
    ]);
    expect(mergeIframeStats(iframe, { "0": { matched: 2, fired: 1 } })).toEqual([
      { rule: "i1", selector: "iframe", action: "never-load", matched: 2, fired: 1 },
    ]);
  });

  it("accepts an empty list — nothing configured is not an error", () => {
    expect(mergeRuntimeStats([], {})).toEqual([]);
    expect(lifecycleStatsFrom([])).toEqual([]);
    expect(mergeIframeStats([], {})).toEqual([]);
  });
});
