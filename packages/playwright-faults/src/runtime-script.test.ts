import { describe, expect, it } from "vitest";
import { buildRuntimeFaultsScript, compileRuntimeFaults } from "./runtime-faults.js";
import type { RuntimeFault } from "./types.js";

/**
 * The runtime layer's real behaviour lives in a template string, which means
 * TypeScript cannot see it and the existing tests only assert its *source
 * text*. A `toContain("const matchMethod =")` passes on any script whose
 * substrings survive and fails on a harmless rename — it cannot tell a
 * working method filter from an inverted one.
 *
 * The script runs fine outside a browser: it is a self-contained IIFE over
 * `window`, so `new Function` plus a stub window executes the same code the
 * page gets. These tests exercise the behaviours that were load-bearing and
 * uncovered — occurrence numbering, method selection, and which body
 * consumers `reject-body` touches — each of which stayed green under an
 * inverting mutation before this file existed.
 */

interface StubResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function install(faults: RuntimeFault[], seed = 1) {
  const calls: Array<{ url: string; method: string }> = [];
  const stubResponse = (): StubResponse => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ real: true }),
    text: () => Promise.resolve("real"),
  });
  const win: Record<string, unknown> = {
    fetch: (input: unknown, init?: { method?: string }) => {
      const url =
        typeof input === "string" ? input : ((input as { url?: string })?.url ?? "");
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      return Promise.resolve(stubResponse());
    },
  };
  const script = buildRuntimeFaultsScript(faults, seed);
  new Function("window", "DOMException", "document", script)(win, DOMException, {});
  const fetch = win.fetch as (input: unknown, init?: unknown) => Promise<StubResponse>;
  const stats = () =>
    win.__chaosbringerRuntimeStats as Record<string, { matched: number; fired: number }>;
  return { fetch, calls, stats };
}

describe("the generated runtime script", () => {
  it("numbers occurrences from 0, so decisions[0] answers the first call", async () => {
    // Off-by-one here means every plan's first decision is the one the model
    // wrote for its second call — with `decisions: ["pass", "inject"]` the
    // app is faulted on the call the model says succeeds.
    const { fetch, calls } = install([
      {
        urlPattern: /\/api\/save/,
        action: { kind: "reject-fetch" },
        schedule: { decisions: ["pass", "inject"] },
      },
    ]);
    await expect(fetch("/api/save")).resolves.toMatchObject({ ok: true });
    await expect(fetch("/api/save")).rejects.toThrow();
    // Only the passing call reached the network.
    expect(calls).toEqual([{ url: "/api/save", method: "GET" }]);
  });

  it("treats `methods` as a selector, not an exclusion", async () => {
    const { fetch, calls } = install([
      { urlPattern: /\/api\/notes/, methods: ["POST"], action: { kind: "reject-fetch" } },
    ]);
    await expect(fetch("/api/notes", { method: "POST" })).rejects.toThrow();
    await expect(fetch("/api/notes")).resolves.toMatchObject({ ok: true });
    // Inverted, the GET would be the one that failed — and a suite that only
    // asserts "the fault fired" would still be green.
    expect(calls).toEqual([{ url: "/api/notes", method: "GET" }]);
  });

  it("counts a matched-but-passed call, and only counts `fired` when it fires", async () => {
    const { fetch, stats } = install([
      {
        urlPattern: /\/api\/save/,
        action: { kind: "reject-fetch" },
        schedule: { decisions: ["pass", "inject"] },
      },
    ]);
    await fetch("/api/save").catch(() => {});
    await fetch("/api/save").catch(() => {});
    await fetch("/api/other").catch(() => {});
    expect(stats()["0"]).toEqual({ matched: 2, fired: 1, suppressed: 0 });
  });

  it("rejects only the body consumers named, and leaves the rest of the Response real", async () => {
    // The default matters more than it looks: it decides which bug a
    // reject-body finds. Patching `text` instead of `json` silently tests a
    // path most apps never take.
    const { fetch } = install([
      { urlPattern: /\/api\/report/, action: { kind: "reject-body" } },
    ]);
    const res = await fetch("/api/report");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow(TypeError);
    await expect(res.text()).resolves.toBe("real");
  });

  it("patches exactly the consumers asked for when they are named", async () => {
    const { fetch } = install([
      { urlPattern: /\/api\/report/, action: { kind: "reject-body", consumers: ["text"] } },
    ]);
    const res = await fetch("/api/report");
    await expect(res.text()).rejects.toThrow(TypeError);
    await expect(res.json()).resolves.toEqual({ real: true });
  });

  it("lets a caller who can cancel escape never-settle-fetch", async () => {
    // The fault has to honour `signal`, or a correctly-bounded app is
    // reported as stuck — the opposite of the finding.
    const { fetch } = install([
      { urlPattern: /\/api\/report/, action: { kind: "never-settle-fetch" } },
    ]);
    const ac = new AbortController();
    const pending = fetch("/api/report", { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow();

    // …and an app that cannot cancel really does wait forever.
    let settled = false;
    void fetch("/api/report").then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });

  it("does not install twice into the same frame", async () => {
    const faults: RuntimeFault[] = [
      { urlPattern: /\/api\/save/, action: { kind: "reject-fetch" } },
    ];
    const calls: Array<string> = [];
    const win: Record<string, unknown> = {
      fetch: (input: unknown) => {
        calls.push(String(input));
        return Promise.resolve({ ok: true });
      },
    };
    const script = buildRuntimeFaultsScript(faults, 1);
    const run = new Function("window", "DOMException", "document", script);
    run(win, DOMException, {});
    const firstPatch = win.fetch;
    run(win, DOMException, {});
    // A second install would wrap the wrapper: one call would be counted
    // twice, and the stats reset would lose the first run's counters.
    expect(win.fetch).toBe(firstPatch);
  });
});

describe("the generated runtime script, less-travelled paths", () => {
  it("credits `fired` to the fault that acted, not to every fault that agreed", async () => {
    // Two scheduled faults on the same URL, both saying inject. Only one can
    // answer the call; the other advanced its occurrence and did nothing.
    // Reporting `fired: 1` for both is how a run claims twice the injections
    // it made.
    const { fetch, stats } = install([
      {
        name: "first",
        urlPattern: /\/api\/save/,
        action: { kind: "reject-fetch" },
        schedule: { decisions: ["inject"] },
      },
      {
        name: "second",
        urlPattern: /\/api\/save/,
        action: { kind: "flaky-fetch" },
        schedule: { decisions: ["inject"] },
      },
    ]);
    await expect(fetch("/api/save")).rejects.toThrow();
    expect(stats()["0"]).toEqual({ matched: 1, fired: 1, suppressed: 0 });
    // Occurrence still advanced — two faults watching one URL must agree on
    // what "occurrence 1" means — and the decision it could not act on is
    // reported as `suppressed`, so it is not mistaken for a schedule that
    // said pass.
    expect(stats()["1"]).toEqual({ matched: 1, fired: 0, suppressed: 1 });
  });

  it("rejects a resolve-rejected-thenable with a TypeError, one microtask late", async () => {
    const { fetch } = install([
      { urlPattern: /\/api\/save/, action: { kind: "resolve-rejected-thenable" } },
    ]);
    await expect(fetch("/api/save")).rejects.toThrow(TypeError);
  });

  it("honours rejectAs on the actions that actually have it", async () => {
    const { fetch } = install([
      {
        urlPattern: /\/api\/save/,
        action: { kind: "reject-fetch", rejectAs: "AbortError" },
      },
    ]);
    await expect(fetch("/api/save")).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("buildRuntimeFaultsScript rejects the shapes that fail silently", () => {
  it("names the compiled-instead-of-raw mistake", () => {
    // The natural guess — and it used to emit a script that threw inside the
    // page and injected nothing, which without a fired-check looks like a pass.
    const compiled = compileRuntimeFaults([
      { urlPattern: /\/api\/save/, action: { kind: "reject-fetch" } },
    ]);
    expect(() => buildRuntimeFaultsScript(compiled as never, 1)).toThrow(
      /output of `compileRuntimeFaults`/,
    );
  });

  it("names a network rule handed to the runtime layer", () => {
    expect(() =>
      buildRuntimeFaultsScript(
        [{ urlPattern: /\/api\/save/, fault: { kind: "abort" } }] as never,
        1,
      ),
    ).toThrow(/network FaultRule/);
  });

  it("still builds from raw runtime faults", () => {
    expect(
      buildRuntimeFaultsScript([{ urlPattern: /\/api\/save/, action: { kind: "reject-fetch" } }], 1),
    ).toContain("chaosFetch");
  });
});
