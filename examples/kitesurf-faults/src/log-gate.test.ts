import { describe, expect, it } from "vitest";
import { CALLER_CANCELLED_MARKER, classifyWorkerdLog } from "./log-gate.js";

// wrangler prints workerd errors as `✘ [ERROR] <message>` wrapped in ANSI
// colour codes; these helpers rebuild the exact bytes from the connection
// spike's logs (Kitesurf 58d10e6, workerd 1.20260911.1).
const err = (msg: string) => `\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1m${msg}\x1b[0m`;

const TEARDOWN = [
  "[ks-kill] 7dd5a543-6211-4a5f-8ffd-0b34cd10fa2d Page.navigate: generation bump",
  err("e = workerd/io/io-context.c++:1557: failed: script terminated for unknown reasons"),
  "",
  "  stack: /k/node_modules/.pnpm/@cloudflare+workerd-linux-64@1.20260911.1/node_modules/@cloudflare/workerd-linux-64/bin/workerd@319edb0 /k/workerd@3a2b",
  "",
].join("\n");

const CDP_CLOSE = [
  err("Uncaught Error: Network connection lost. "),
  '[kitesurf-ws] post-close async settled: {"message":"Uncaught Error: Network connection lost.","type":"error","filename":"","lineno":0,"colno":0,"error_name":"Error","error_message":"Network connection lost."}',
  "[ks-kill] a29fd298-d186-4df0-8df4-cfa8e22d408a engine WS closed",
].join("\n");

const INJECTED_ABORT = [
  err("Uncaught Error: kitesurf-faults: injected abort Error"),
  "",
  "      at fetch (file:///x/host.ts:217:13)",
  "",
  err("Uncaught Error: kitesurf-faults: injected abort "),
  err("Uncaught Error: kitesurf-faults: injected abort "),
  err("[kitesurf] fetch network error: Error: kitesurf-faults: injected abort"),
  "      at null.<anonymous> (async file:///bundle/page.js:11:21856)",
  "    remote: true",
].join("\n");

const RUN_LOST = [
  err("Uncaught Error: run-lost: r-lost Error"),
  err("Uncaught Error: run-lost: r-lost "),
  err("[page-M3PrqXboJ7-60a09df691f840bd91094b71a78438d2-1] [kitesurf] fetch network error: Error: run-lost: r-lost"),
].join("\n");

const NOISE = [
  "[wrangler:info] GET /__chaos/stats 200 OK (9ms)",
  "[kitesurf-nav] done url=https://shop.invalid/ consoleEntries=0 mutations=0",
  "▲ [WARNING] [ks-egress] slow headers: 3002ms type=Fetch url=https://shop.invalid/api/slow",
].join("\n");

describe("classifyWorkerdLog", () => {
  it("allows Kitesurf's page teardown and CDP-close lines", () => {
    const r = classifyWorkerdLog([NOISE, TEARDOWN, CDP_CLOSE, TEARDOWN].join("\n"), { injectedAborts: 0 });
    expect(r.unexpected).toEqual([]);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.allowlisted).toEqual({ "page-isolate-teardown": 2, "cdp-close": 2 });
  });

  it("fails on any other uncaught error", () => {
    const r = classifyWorkerdLog([TEARDOWN, err("Uncaught TypeError: x is not a function")].join("\n"), { injectedAborts: 0 });
    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual(["✘ [ERROR] Uncaught TypeError: x is not a function"]);
  });

  it("fails on an [ERROR] line or a bare Error: line that is not allowlisted", () => {
    const r = classifyWorkerdLog([err("Could not resolve \"@kitesurf/engine/embed\""), "Error: boom"].join("\n"), { injectedAborts: 0 });
    expect(r.unexpected).toHaveLength(2);
    expect(r.ok).toBe(false);
  });

  it("counts injected-abort lines and accepts them when the stats injected an abort", () => {
    const r = classifyWorkerdLog([INJECTED_ABORT, TEARDOWN].join("\n"), { injectedAborts: 1 });
    expect(r.injectedAbortLines).toBe(4);
    expect(r.ok).toBe(true);
  });

  it("fails injected-abort lines when no abort was injected", () => {
    // The marker without a matching injection: something threw the marker
    // text that the session did not decide to throw.
    const r = classifyWorkerdLog(INJECTED_ABORT, { injectedAborts: 0 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toContain("injected-abort lines without an injected abort");
  });

  it("fails an injected abort that left no trace in the log", () => {
    const r = classifyWorkerdLog(TEARDOWN, { injectedAborts: 1 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toContain("no injected-abort line");
  });

  it("allows run-lost only for the named run", () => {
    expect(classifyWorkerdLog(RUN_LOST, { injectedAborts: 0, runLostIds: ["r-lost"] })).toMatchObject({
      ok: true,
      runLostLines: 3,
    });
    const other = classifyWorkerdLog(RUN_LOST, { injectedAborts: 0, runLostIds: ["r-other"] });
    expect(other.ok).toBe(false);
    expect(other.unexpected).toHaveLength(3);
    expect(classifyWorkerdLog(RUN_LOST, { injectedAborts: 0 }).ok).toBe(false);
  });

  it("does not let a run id prefix stand in for another run", () => {
    const r = classifyWorkerdLog(err("Uncaught Error: run-lost: r-lost-2 "), { injectedAborts: 0, runLostIds: ["r-lost"] });
    expect(r.ok).toBe(false);
  });

  it("fails a promise settled from another request context (a leaked wait)", () => {
    const line =
      "▲ [WARNING] A promise was resolved or rejected from a different request context than the one it was created in. However, the creating request has already been completed or canceled.";
    const r = classifyWorkerdLog(line, { injectedAborts: 0 });
    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual([line]);
  });

  it("allows disposed-session lines only when a dispose cut a request short", () => {
    const line = err("Uncaught Error: kitesurf-faults: the fault egress session is disposed ");
    expect(classifyWorkerdLog(line, { injectedAborts: 0, disposedInFlight: 1 }).ok).toBe(true);
    expect(classifyWorkerdLog(line, { injectedAborts: 0 }).ok).toBe(false);
  });

  it("allows caller-cancelled lines only when a cancellation was counted", () => {
    // workerd logs a cancelled Service Binding call's rejection; with the
    // bare abort reason that line reads `Uncaught  ` and says nothing, so the
    // host rethrows it under a marker (src/host.ts).
    const line = err(`Uncaught Error: ${CALLER_CANCELLED_MARKER} (run r-close) `);
    expect(classifyWorkerdLog(line, { injectedAborts: 0, callerCancelled: 1 })).toMatchObject({ ok: true, callerCancelledLines: 1 });
    expect(classifyWorkerdLog(line, { injectedAborts: 0 }).ok).toBe(false);
    // The anonymous form stays a failure: it cannot be attributed.
    expect(classifyWorkerdLog(err("Uncaught  "), { injectedAborts: 0, callerCancelled: 1 }).ok).toBe(false);
  });

  it("fails a run whose log is empty", () => {
    // wrangler always prints its banner and request lines; an empty log means
    // the log was never captured, not that nothing went wrong.
    expect(classifyWorkerdLog("", { injectedAborts: 0 }).ok).toBe(false);
  });
});
