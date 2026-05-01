import { describe, expect, it } from "vitest";
import { buildActionHeatmap, formatHeatmap } from "./heatmap.js";
import type { ActionResult } from "./types.js";

function action(overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    type: "click",
    target: "Sign in",
    selector: "a[href='/signin']",
    success: true,
    timestamp: 0,
    ...overrides,
  };
}

describe("buildActionHeatmap", () => {
  it("returns an empty array for no actions", () => {
    expect(buildActionHeatmap([])).toEqual([]);
  });

  it("groups by (type, target) and counts", () => {
    const h = buildActionHeatmap([
      action({ target: "A" }),
      action({ target: "A" }),
      action({ target: "B" }),
    ]);
    const a = h.find((e) => e.key === "A")!;
    const b = h.find((e) => e.key === "B")!;
    expect(a.count).toBe(2);
    expect(b.count).toBe(1);
  });

  it("sorts by count descending, then by failures, then alphabetically", () => {
    const h = buildActionHeatmap([
      action({ target: "Apple" }),
      action({ target: "Banana" }),
      action({ target: "Banana" }),
      action({ target: "Cherry" }),
      action({ target: "Cherry" }),
    ]);
    expect(h.map((e) => e.key)).toEqual(["Banana", "Cherry", "Apple"]);
  });

  it("splits success vs failure counts", () => {
    const h = buildActionHeatmap([
      action({ target: "X", success: true }),
      action({ target: "X", success: false }),
      action({ target: "X", success: false }),
    ]);
    const x = h[0]!;
    expect(x.count).toBe(3);
    expect(x.successCount).toBe(1);
    expect(x.failureCount).toBe(2);
  });

  it("counts blockedExternal and shardSkipped", () => {
    const h = buildActionHeatmap([
      action({ target: "Out", success: true, blockedExternal: true }),
      action({ target: "Out", success: true, blockedExternal: true }),
      action({
        target: "Out",
        success: true,
        // Cast through the field — older reports may not have it.
        shardSkipped: true,
      } as ActionResult),
    ]);
    const out = h[0]!;
    expect(out.blockedExternalCount).toBe(2);
    expect(out.shardSkippedCount).toBe(1);
  });

  it("treats different action types as separate buckets even with the same key", () => {
    const h = buildActionHeatmap([
      action({ type: "click", target: "Search" }),
      action({ type: "input", target: "Search" }),
    ]);
    expect(h).toHaveLength(2);
    const types = h.map((e) => e.type).sort();
    expect(types).toEqual(["click", "input"]);
  });

  it("falls back to the selector when target is missing", () => {
    const h = buildActionHeatmap([
      action({ target: undefined, selector: "button.primary" }),
    ]);
    expect(h[0]!.key).toBe("button.primary");
  });

  it("collapses fully-anonymous actions into '(unknown)'", () => {
    const h = buildActionHeatmap([
      action({ target: undefined, selector: undefined }),
      action({ target: undefined, selector: undefined }),
    ]);
    expect(h).toHaveLength(1);
    expect(h[0]!.key).toBe("(unknown)");
    expect(h[0]!.count).toBe(2);
  });
});

describe("formatHeatmap", () => {
  it("renders an empty notice when no actions are recorded", () => {
    expect(formatHeatmap([])).toBe("No actions recorded.");
  });

  it("limits output to the top-N rows", () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      buildActionHeatmap([action({ target: `T${i}` })])[0]!
    );
    const out = formatHeatmap(entries, 5);
    expect(out).toContain("(25 more)");
    // Five data rows -> roughly 5 occurrences of the type column.
    const dataRows = out.split("\n").filter((l) => l.startsWith("click"));
    expect(dataRows).toHaveLength(5);
  });

  it("includes type, count, OK%, fail / ext / sh columns", () => {
    const out = formatHeatmap(
      buildActionHeatmap([
        action({ target: "Greet", success: true }),
        action({ target: "Greet", success: false }),
      ])
    );
    expect(out).toContain("Type");
    expect(out).toContain("Count");
    expect(out).toContain("OK%");
    expect(out).toContain("Fail");
    expect(out).toContain("Ext");
    expect(out).toContain("Greet");
    expect(out).toMatch(/click\s+2\s+50%/);
  });

  it("truncates very long target keys", () => {
    const long = "x".repeat(200);
    const out = formatHeatmap(buildActionHeatmap([action({ target: long })]));
    expect(out).toContain("...");
    expect(out).not.toContain(long);
  });
});
