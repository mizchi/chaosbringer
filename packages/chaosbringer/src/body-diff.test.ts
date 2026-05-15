import { describe, expect, it } from "vitest";
import { diffJsonBodies, summariseBodyDiff } from "./body-diff.js";

describe("diffJsonBodies", () => {
  it("returns null when bodies are byte-identical", () => {
    expect(diffJsonBodies('{"id":1}', '{"id":1}')).toBeNull();
  });

  it("reports a top-level field changed", () => {
    const diff = diffJsonBodies('{"id":1}', '{"id":2}');
    expect(diff?.entries).toEqual([{ path: "id", kind: "changed", left: 1, right: 2 }]);
  });

  it("reports a removed field by name (left has, right doesn't)", () => {
    const diff = diffJsonBodies(
      '{"id":1,"email":"a@x"}',
      '{"id":1}',
    );
    expect(diff?.entries).toEqual([{ path: "email", kind: "removed", left: "a@x" }]);
  });

  it("reports an added field by name (right has, left doesn't)", () => {
    const diff = diffJsonBodies('{"id":1}', '{"id":1,"new":"x"}');
    expect(diff?.entries).toEqual([{ path: "new", kind: "added", right: "x" }]);
  });

  it("descends into nested objects with a dotted path", () => {
    const diff = diffJsonBodies(
      '{"user":{"profile":{"name":"a"}}}',
      '{"user":{"profile":{"name":"b"}}}',
    );
    expect(diff?.entries).toEqual([
      { path: "user.profile.name", kind: "changed", left: "a", right: "b" },
    ]);
  });

  it("indexes into arrays by position with numeric segments", () => {
    const diff = diffJsonBodies('[10,20,30]', '[10,99,30]');
    expect(diff?.entries).toEqual([{ path: "1", kind: "changed", left: 20, right: 99 }]);
  });

  it("reports array length differences as added/removed at the trailing index", () => {
    const diff = diffJsonBodies('[1,2]', '[1,2,3]');
    expect(diff?.entries).toEqual([{ path: "2", kind: "added", right: 3 }]);
  });

  it("reports a type mismatch at the boundary and stops descending", () => {
    const diff = diffJsonBodies('{"items":[1,2]}', '{"items":"abc"}');
    // We do NOT descend into 'items' on either side — different shape
    // is reported at the boundary.
    expect(diff?.entries).toEqual([
      { path: "items", kind: "typed", left: [1, 2], right: "abc" },
    ]);
  });

  it("flags one-side-non-JSON bodies with a root-level typed entry (content-type drift)", () => {
    // One side is HTML, the other JSON — real content-type drift.
    const diff = diffJsonBodies("<html>x</html>", '{"id":1}');
    expect(diff?.entries[0].kind).toBe("typed");
    expect(diff?.entries[0].path).toBe("");
  });

  it("returns null when BOTH bodies are non-JSON (no useful structural info to add)", () => {
    // Both HTML — the hash mismatch already tells the operator they
    // differ. Reporting a fake 'typed' here would be misleading.
    const diff = diffJsonBodies("<html>a</html>", "<html>b</html>");
    expect(diff).toBeNull();
  });

  it("treats null bodies as null JSON (returns null if both are null)", () => {
    expect(diffJsonBodies(null, null)).toBeNull();
    // null vs "{}" → null vs an object → typed at root.
    const diff = diffJsonBodies(null, "{}");
    expect(diff?.entries[0].kind).toBe("typed");
  });

  it("Object.is semantics — NaN equal to NaN, +0 not equal to -0", () => {
    // NaN encodes as null in JSON, so this is the practical edge case:
    // we compare via Object.is after JSON.parse already normalised both
    // sides, so 0 vs -0 stays as one entry.
    expect(diffJsonBodies("0", "-0")?.entries).toHaveLength(1);
  });

  it("honours the maxEntries cap and signals truncation", () => {
    const left = JSON.stringify(Array.from({ length: 200 }, (_, i) => i));
    const right = JSON.stringify(Array.from({ length: 200 }, (_, i) => i + 1));
    const diff = diffJsonBodies(left, right, { maxEntries: 5 });
    expect(diff?.entries).toHaveLength(5);
    expect(diff?.truncated).toBe(true);
  });

  it("reports both directions of drift in one pass", () => {
    const diff = diffJsonBodies(
      '{"keep":1,"only_left":2}',
      '{"keep":1,"only_right":3}',
    );
    expect(diff?.entries.map((e) => e.path).sort()).toEqual(["only_left", "only_right"]);
  });
});

describe("summariseBodyDiff", () => {
  it("renders a 'changed' leaf with arrow-style output", () => {
    const diff = diffJsonBodies('{"title":"a"}', '{"title":"B"}');
    expect(summariseBodyDiff(diff)).toContain('title: "a" → "B"');
  });

  it("renders 'removed' with a minus prefix", () => {
    const diff = diffJsonBodies('{"x":1,"email":"a"}', '{"x":1}');
    expect(summariseBodyDiff(diff)).toContain('email: -"a"');
  });

  it("renders 'added' with a plus prefix", () => {
    const diff = diffJsonBodies('{"x":1}', '{"x":1,"new":"v"}');
    expect(summariseBodyDiff(diff)).toContain('new: +"v"');
  });

  it("caps at the limit and signals overflow with '(+N more)'", () => {
    const left = JSON.stringify({ a: 1, b: 1, c: 1, d: 1, e: 1 });
    const right = JSON.stringify({ a: 2, b: 2, c: 2, d: 2, e: 2 });
    const diff = diffJsonBodies(left, right);
    expect(summariseBodyDiff(diff, 2)).toContain("(+3 more");
  });

  it("renders type mismatches as 'type X → Y'", () => {
    const diff = diffJsonBodies('{"x":[1]}', '{"x":"y"}');
    expect(summariseBodyDiff(diff)).toContain("type array → string");
  });

  it("returns empty string for null/empty diff", () => {
    expect(summariseBodyDiff(null)).toBe("");
  });
});
