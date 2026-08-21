import { describe, expect, it } from "vitest";
import { compileLifecycleFaults, lifecycleMatchesUrl } from "./lifecycle-faults.js";
import {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  runtimeMatchesUrl,
} from "./runtime-faults.js";
import { compileUrlMatcher, stripStatefulFlags } from "./url-matcher.js";

/**
 * A fault rule holds one compiled pattern for the lifetime of a run and tests
 * it against every request that goes past. `g` and `y` give a RegExp a
 * `lastIndex` that `test()` writes as well as reads, so the *second* test of
 * the same pattern starts searching where the first match ended: the rule
 * fires on alternating requests, and stops firing at all once `lastIndex` is
 * past the end of a shorter URL. Nobody writing `/\/api\/save/g` means that.
 */
describe("compileUrlMatcher", () => {
  it("keeps a stateful pattern from firing on every other request", () => {
    const stateful = /\/api\/save/g;
    // The bug, demonstrated on the raw regex first so the fix has something
    // to be a fix of.
    expect(stateful.test("/api/save")).toBe(true);
    expect(stateful.test("/api/save")).toBe(false);

    const compiled = compileUrlMatcher(/\/api\/save/g);
    expect(compiled.test("/api/save")).toBe(true);
    expect(compiled.test("/api/save")).toBe(true);
    expect(compiled.test("/api/save")).toBe(true);
  });

  it("leaves the caller's regex untouched — it may be in use elsewhere", () => {
    const mine = /\/api\/save/g;
    const compiled = compileUrlMatcher(mine);
    expect(compiled).not.toBe(mine);
    expect(mine.flags).toBe("g");
  });

  it("honours every flag that is a matching question", () => {
    expect(compileUrlMatcher(/\/API\/Save/i).test("/api/save")).toBe(true);
    expect(compileUrlMatcher(/a.b/s).flags).toBe("s");
    expect(compileUrlMatcher(/\u{1F600}/u).flags).toBe("u");
    // A pattern with nothing to strip is passed through by identity, so a
    // caller comparing patterns by reference still can.
    const plain = /\/api\/save/i;
    expect(compileUrlMatcher(plain)).toBe(plain);
  });

  it("drops only the stateful pair from a mixed flag string", () => {
    expect(stripStatefulFlags("gimsy")).toBe("ims");
    expect(compileUrlMatcher(/\/api\/x/giy).flags).toBe("i");
  });

  it("compiles a string matcher", () => {
    expect(compileUrlMatcher("/api/save").test("http://x/api/save")).toBe(true);
  });
});

describe("the fault layers compile their patterns statelessly", () => {
  it("runtime faults match the same URL twice", () => {
    const [compiled] = compileRuntimeFaults([
      { urlPattern: /\/api\/save/g, action: { kind: "reject-fetch" } },
    ]);
    expect(runtimeMatchesUrl(compiled!, "/api/save")).toBe(true);
    expect(runtimeMatchesUrl(compiled!, "/api/save")).toBe(true);
  });

  it("lifecycle faults match the same URL twice", () => {
    const [compiled] = compileLifecycleFaults([
      {
        when: "afterLoad",
        urlPattern: /\/list/g,
        action: { kind: "clear-storage", scopes: ["localStorage"] },
      },
    ]);
    expect(lifecycleMatchesUrl(compiled!, "/list")).toBe(true);
    expect(lifecycleMatchesUrl(compiled!, "/list")).toBe(true);
  });

  it("does not ship a stateful flag into the page either", () => {
    // Less load-bearing than the two above, and worth being precise about:
    // the in-page matcher rebuilds `new RegExp(source, flags)` on every call,
    // so a `g` that reached the page would be inert rather than wrong. The
    // reason to strip it here is that the two sides should describe the same
    // pattern — a Node-side rule that ignores `g` and a page-side twin that
    // carries it is a difference somebody will eventually have to explain.
    const script = buildRuntimeFaultsScript(
      [{ urlPattern: /\/api\/save/g, action: { kind: "reject-fetch" } }],
      1,
    );
    expect(script).toContain('"source":"\\\\/api\\\\/save"');
    expect(script).not.toMatch(/"flags":"[^"]*[gy]/);
  });
});
