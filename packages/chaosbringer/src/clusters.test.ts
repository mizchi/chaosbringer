import { describe, expect, it } from "vitest";
import { clusterErrors, fingerprintError } from "./clusters.js";
import type { PageError } from "./types.js";

function err(overrides: Partial<PageError> & { message: string; type: PageError["type"] }): PageError {
  return {
    timestamp: 0,
    ...overrides,
  };
}

describe("fingerprintError", () => {
  it("strips URLs so identical-shape messages collide", () => {
    const a = fingerprintError(err({ type: "console", message: "Failed: http://x:3000/a/1" }));
    const b = fingerprintError(err({ type: "console", message: "Failed: http://y:9999/b/2" }));
    expect(a).toBe(b);
  });

  it("strips source locations", () => {
    const a = fingerprintError(err({ type: "exception", message: "boom at a.js:12:5" }));
    const b = fingerprintError(err({ type: "exception", message: "boom at a.js:99:7" }));
    expect(a).toBe(b);
  });

  it("strips large numeric ids but keeps small ones", () => {
    const a = fingerprintError(err({ type: "console", message: "user 12345 not found" }));
    const b = fingerprintError(err({ type: "console", message: "user 98765 not found" }));
    expect(a).toBe(b);
  });

  it("distinct message shapes produce distinct fingerprints", () => {
    expect(fingerprintError(err({ type: "console", message: "network failed" }))).not.toBe(
      fingerprintError(err({ type: "console", message: "auth rejected" }))
    );
  });
});

describe("clusterErrors", () => {
  it("collapses identical errors", () => {
    const errors: PageError[] = Array.from({ length: 10 }, () =>
      err({ type: "console", message: "same message" })
    );
    const clusters = clusterErrors(errors);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(10);
  });

  it("splits distinct types apart even with same fingerprint", () => {
    const clusters = clusterErrors([
      err({ type: "console", message: "oops" }),
      err({ type: "exception", message: "oops" }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it("tracks distinct urls on a cluster", () => {
    const clusters = clusterErrors([
      err({ type: "console", message: "HTTP 500 on http://x/a", url: "http://x/a" }),
      err({ type: "console", message: "HTTP 500 on http://x/b", url: "http://x/b" }),
      err({ type: "console", message: "HTTP 500 on http://x/a", url: "http://x/a" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(3);
    expect(clusters[0]!.urls.sort()).toEqual(["http://x/a", "http://x/b"]);
  });

  it("sorts most frequent cluster first", () => {
    const clusters = clusterErrors([
      err({ type: "console", message: "rare" }),
      ...Array.from({ length: 5 }, () => err({ type: "console", message: "common" })),
      err({ type: "console", message: "rare" }),
    ]);
    expect(clusters[0]!.count).toBe(5);
    expect(clusters[1]!.count).toBe(2);
  });

  it("records invariant names per cluster", () => {
    const clusters = clusterErrors([
      err({ type: "invariant-violation", message: "[has-h1] no <h1>", invariantName: "has-h1" }),
      err({ type: "invariant-violation", message: "[has-h1] no <h1>", invariantName: "has-h1" }),
    ]);
    expect(clusters[0]!.invariantNames).toEqual(["has-h1"]);
  });
});
