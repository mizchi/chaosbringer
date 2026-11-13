import { describe, expect, it } from "vitest";
import { MAX_RUN_AGE_MS, MAX_RUNS, RunRegistry } from "./registry.js";

/** A session double that records how often it was disposed. */
const fakeSession = () => {
  const s = { disposals: 0, async dispose() { s.disposals++; } };
  return s;
};

const clock = (start = 1_000) => {
  const c = { t: start, now: () => c.t };
  return c;
};

describe("RunRegistry", () => {
  it("creates a run and looks it up by id", () => {
    const reg = new RunRegistry({ now: clock().now });
    const made = reg.create("r1", () => fakeSession());
    expect(made.ok).toBe(true);
    const entry = reg.get("r1");
    expect(entry?.id).toBe("r1");
    expect(entry?.disposed).toBe(false);
    expect(entry?.upstream).toEqual({});
    expect(entry?.inFlight).toBe(0);
    expect(entry?.sessionEnds).toEqual([]);
  });

  it("hands the new entry to the session factory so upstream counters can close over it", () => {
    const reg = new RunRegistry();
    reg.create("r1", (entry) => {
      entry.upstream["/x"] = 1;
      return fakeSession();
    });
    expect(reg.get("r1")?.upstream).toEqual({ "/x": 1 });
  });

  it("returns undefined for an unknown run, never a fresh one", () => {
    const reg = new RunRegistry();
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it("refuses a duplicate id with 409", () => {
    const reg = new RunRegistry();
    reg.create("r1", () => fakeSession());
    expect(reg.create("r1", () => fakeSession())).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses an id that is not a short token with 400", () => {
    const reg = new RunRegistry();
    for (const id of ["", "a b", "x".repeat(65), "r/1", "r?1"]) {
      expect(reg.create(id, () => fakeSession())).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("reports a session factory that throws as 400 and keeps nothing", () => {
    const reg = new RunRegistry();
    const r = reg.create("r1", () => {
      throw new Error("kitesurf-faults: bad rule");
    });
    expect(r).toMatchObject({ ok: false, status: 400, error: "kitesurf-faults: bad rule" });
    expect(reg.get("r1")).toBeUndefined();
  });

  it(`refuses run ${MAX_RUNS + 1} with 429`, () => {
    const reg = new RunRegistry();
    for (let i = 0; i < MAX_RUNS; i++) expect(reg.create(`r${i}`, () => fakeSession()).ok).toBe(true);
    expect(reg.create("one-more", () => fakeSession())).toMatchObject({ ok: false, status: 429 });
    expect(reg.size).toBe(MAX_RUNS);
  });

  it("disposes once, keeps the entry readable, and treats a second dispose as a no-op", async () => {
    const reg = new RunRegistry();
    const s = fakeSession();
    reg.create("r1", () => s);
    expect((await reg.dispose("r1"))?.disposed).toBe(true);
    expect((await reg.dispose("r1"))?.disposed).toBe(true);
    expect(s.disposals).toBe(1);
    expect(reg.get("r1")?.disposed).toBe(true);
  });

  it("delete disposes and removes; later lookups are run-lost", async () => {
    const reg = new RunRegistry();
    const s = fakeSession();
    reg.create("r1", () => s);
    expect((await reg.delete("r1"))?.id).toBe("r1");
    expect(s.disposals).toBe(1);
    expect(reg.get("r1")).toBeUndefined();
    expect(await reg.delete("r1")).toBeUndefined();
    expect(await reg.dispose("r1")).toBeUndefined();
  });

  it("sweeps runs older than the age limit on create, disposing them", () => {
    const c = clock();
    const reg = new RunRegistry({ now: c.now });
    const old = fakeSession();
    reg.create("old", () => old);
    c.t += MAX_RUN_AGE_MS;
    reg.create("young", () => fakeSession());
    // Exactly at the limit is still alive; one ms past it is not.
    expect(reg.get("old")).toBeDefined();
    c.t += 1;
    reg.create("newest", () => fakeSession());
    expect(reg.get("old")).toBeUndefined();
    expect(old.disposals).toBe(1);
    expect(reg.get("young")).toBeDefined();
  });

  it("frees room for a new run once old ones are swept", () => {
    const c = clock();
    const reg = new RunRegistry({ now: c.now, maxRuns: 2, maxAgeMs: 10 });
    reg.create("a", () => fakeSession());
    reg.create("b", () => fakeSession());
    expect(reg.create("c", () => fakeSession())).toMatchObject({ status: 429 });
    c.t += 11;
    expect(reg.create("c", () => fakeSession()).ok).toBe(true);
    expect(reg.size).toBe(1);
  });

  // A run and a CDP connection are one to one: a second connection on the
  // same run would share its occurrence counters and RNG with the first.
  describe("connect()", () => {
    it("binds the first connection and refuses a second one with 409", () => {
      const reg = new RunRegistry();
      reg.create("r1", () => fakeSession());
      const first = reg.connect("r1");
      expect(first).toMatchObject({ ok: true });
      expect(reg.get("r1")?.connected).toBe(true);
      expect(reg.connect("r1")).toMatchObject({ ok: false, status: 409, error: "run r1 already has a connection" });
    });

    it("stays bound after the connection ends, so a reconnect cannot pick up the old counters", () => {
      const reg = new RunRegistry();
      reg.create("r1", () => fakeSession());
      reg.connect("r1");
      reg.get("r1")?.sessionEnds.push({ connectionId: "c1", at: 0 });
      expect(reg.connect("r1")).toMatchObject({ ok: false, status: 409 });
    });

    it("refuses an unknown or disposed run as run-lost, and binds nothing", async () => {
      const reg = new RunRegistry();
      expect(reg.connect("nope")).toMatchObject({ ok: false, status: 409, error: "run-lost: nope" });
      reg.create("r1", () => fakeSession());
      await reg.dispose("r1");
      expect(reg.connect("r1")).toMatchObject({ ok: false, status: 409, error: "run-lost: r1" });
      expect(reg.get("r1")?.connected).toBe(false);
    });

    it("keeps runs independent: binding one does not bind another", () => {
      const reg = new RunRegistry();
      reg.create("a", () => fakeSession());
      reg.create("b", () => fakeSession());
      reg.connect("a");
      expect(reg.connect("b")).toMatchObject({ ok: true });
    });
  });
});
