// The integration scenarios, driven over CDP against a running host Worker.
//
// Each scenario creates its own run(s) through the control plane, connects
// with /devtools/browser?run=<id>, and judges the page, the session's stats
// and the fixture server's call counts together (src/oracle.ts). Teardown is
// the harness's: in a finally, every run's stats are fetched, its socket
// closed, its session disposed and its entry deleted, and a teardown that
// could not do one of those fails the scenario (統計欠落 / 未完了の後始末).
//
// S2 and S3 are expected to FAIL the oracle; they pass as scenarios only when
// the oracle rejects them for the expected reason and the run shows the facts
// behind that reason (BROKEN_OWN, MISSING_URL_OWN).

import { evaluate } from "../src/oracle.ts";
import { connect, upgradeStatus } from "./cdp-client.mjs";

const ORIGIN = "https://shop.invalid";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CART_RULE = {
  name: "cart-503-once",
  urlPattern: "^https://shop\\.invalid/api/cart$",
  methods: ["GET"],
  fault: { kind: "status", status: 503 },
  schedule: { decisions: ["inject"] },
};

export const cartExpect = (page) => ({
  dom: { attempts: "503,200", result: "ok:3" },
  stats: [{ rule: "cart-503-once", matched: 2, injected: 1 }],
  upstream: { "/api/cart": 1, [page]: 1 },
});

// What an expected failure must also show on its own, so it fails for the
// reason its scenario names and not for some other one. A broken page whose
// rule never fired still differs from the correct page's DOM, and lost stats
// add a code rather than replace one, so the oracle's code alone proves little.

/** S2: the broken page saw the injected 503, gave up, and never asked again. */
export const BROKEN_OWN = {
  dom: { attempts: "503", result: "failed" },
  stats: [{ rule: "cart-503-once", matched: 1, injected: 1 }],
  upstream: { "/api/cart": 0, "/broken/": 1 },
};

/** S3: the rule never matched, and the page loaded the cart normally. */
export const MISSING_URL_OWN = {
  dom: { attempts: "200", result: "ok:3" },
  stats: [{ rule: "cart-503-once", matched: 0, injected: 0 }],
  upstream: { "/api/cart": 1, "/correct/": 1 },
};

/**
 * Judge with the oracle. Without `expected`, the oracle must pass. With
 * `{code, own}`, it must fail with `code`, and the run must meet `own`, the
 * facts that show why it failed.
 */
export const judge = (input, expected) => {
  const verdict = evaluate(input);
  const codes = [...new Set(verdict.reasons.map((r) => r.code))];
  const result = verdict.ok ? "pass" : `fail:${codes.join("+")}`;
  if (!expected) return { expected: "pass", result, matched: verdict.ok, reasons: verdict.reasons };
  const own = evaluate({ ...input, expect: expected.own });
  return {
    expected: `fail:${expected.code}`,
    result,
    matched: !verdict.ok && codes.includes(expected.code) && own.ok,
    reasons: verdict.reasons,
    ownReasons: own.reasons,
  };
};

export async function runChecks({ base, token, log = (...a) => console.error("[checks]", ...a) }) {
  const wsBase = base.replace(/^http/, "ws");
  // What the log gate needs to know about the faults this run caused on purpose.
  const gate = { injectedAborts: 0, runLostIds: [], disposedInFlight: 0, callerCancelled: 0 };
  const scenarios = [];

  async function ctl(op, { run, body, method = "POST" } = {}) {
    const url = `${base}/__chaos/${op}${run ? `?run=${encodeURIComponent(run)}` : ""}`;
    const init = { method, headers: { "x-chaos-control-token": token } };
    if (body) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json ?? text };
  }

  async function createRun(runId, rules, { seed = 1, maxDelayMs } = {}) {
    const r = await ctl("create", { body: { runId, rules, seed, maxDelayMs } });
    if (r.status !== 200) throw new Error(`create ${runId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  const stats = async (runId) => {
    const r = await ctl("stats", { run: runId, method: "GET" });
    return r.status === 200 ? r.body : undefined;
  };

  /** Poll the run's stats until `pred` holds; returns the last snapshot. */
  async function statsUntil(runId, pred, timeout = 5_000) {
    const end = Date.now() + timeout;
    let s;
    do {
      s = await stats(runId);
      if (s && pred(s)) return s;
      await sleep(100);
    } while (Date.now() < end);
    return s;
  }

  /**
   * Close the socket, then dispose and delete the run, checking each step.
   * Returns the problems found (empty when the teardown was complete) and
   * the last stats snapshot taken before the delete.
   */
  async function teardown(runId, cdp, { lost = false, beforeDelete } = {}) {
    const problems = [];
    const before = await stats(runId);
    if (!lost && !before) problems.push(`stats for ${runId} could not be fetched`);
    if (lost && before) problems.push(`run ${runId} was deleted but still answers stats`);
    let wasOpen = false;
    if (cdp) {
      wasOpen = !cdp.closed;
      const c = await cdp.close().catch((e) => ({ error: String(e) }));
      if (c?.timeout || c?.error) problems.push(`socket of ${runId} did not close: ${JSON.stringify(c)}`);
    }
    if (lost) return { problems, final: before };
    const disposed = await ctl("dispose", { run: runId });
    if (disposed.status !== 200) problems.push(`dispose ${runId}: ${disposed.status}`);
    // The engine reports the end of the connection asynchronously, and a
    // call cut short by the close settles once workerd delivers the abort.
    const final = await statsUntil(runId, (s) => s.inFlight === 0 && (!wasOpen || s.sessionEnds.length > 0));
    if (!final) problems.push(`stats for ${runId} lost after dispose`);
    else {
      if (final.inFlight !== 0) problems.push(`${runId}: ${final.inFlight} egress call(s) still in flight after dispose`);
      if (wasOpen && final.sessionEnds.length === 0) problems.push(`${runId}: no session_end after the socket closed`);
      if (!final.disposed) problems.push(`${runId}: not marked disposed`);
      gate.disposedInFlight += final.disposedInFlight;
      gate.callerCancelled += final.callerCancelled;
    }
    if (beforeDelete) problems.push(...(await beforeDelete()));
    const deleted = await ctl("delete", { run: runId });
    if (deleted.status !== 200) problems.push(`delete ${runId}: ${deleted.status}`);
    return { problems, final };
  }

  const pageFor = async (runId) => {
    const cdp = await connect(`${wsBase}/devtools/browser?run=${encodeURIComponent(runId)}`);
    const { sessionId } = await cdp.newPage();
    return { cdp, sessionId };
  };

  /** Navigate to a cart page and wait for its final DOM. */
  async function loadCart(cdp, sessionId, path) {
    const nav = await cdp.navigate(sessionId, `${ORIGIN}${path}`);
    await cdp.waitFor(sessionId, "document.getElementById('attempts')?.textContent", (v) => typeof v === "string" && v.length > 0);
    return { nav, dom: { attempts: await cdp.domText(sessionId, "#attempts"), result: await cdp.domText(sessionId, "#result") } };
  }

  /**
   * Run one scenario. `body` returns {expected, result, reasons, ...details};
   * the scenario passes when the result is the expected one and every
   * teardown it registered was complete.
   */
  async function scenario(name, body) {
    const started = Date.now();
    const owned = [];
    const own = (runId, cdp, opts) => owned.push({ runId, cdp, opts });
    let out;
    try {
      out = await body(own);
    } catch (e) {
      out = { expected: "pass", result: "error", reasons: [String(e?.stack ?? e)] };
    }
    const teardowns = [];
    for (const o of owned.reverse()) {
      try {
        teardowns.push({ runId: o.runId, ...(await teardown(o.runId, o.cdp, o.opts)) });
      } catch (e) {
        teardowns.push({ runId: o.runId, problems: [`teardown threw: ${e}`] });
      }
    }
    const teardownProblems = teardowns.flatMap((t) => t.problems);
    const ok = out.matched === true && teardownProblems.length === 0;
    const record = { name, ok, durationMs: Date.now() - started, ...out, teardown: teardowns, teardownProblems };
    scenarios.push(record);
    log(`${ok ? "ok  " : "FAIL"} ${name}: expected ${out.expected}, got ${out.result}${ok ? "" : ` ${JSON.stringify([...(out.reasons ?? []), ...teardownProblems])}`}`);
    return record;
  }

  // S1: the issue's first example.
  await scenario("S1 correct-recovers", async (own) => {
    await createRun("r-correct", [CART_RULE]);
    const { cdp, sessionId } = await pageFor("r-correct");
    own("r-correct", cdp);
    const { dom } = await loadCart(cdp, sessionId, "/correct/");
    const s = await stats("r-correct");
    return { ...judge({ dom, stats: s?.stats, upstream: s?.upstream, expect: cartExpect("/correct/") }), dom, stats: s?.stats, upstream: s?.upstream };
  });

  // S2: the same rules and oracle on the page that cannot handle a 503.
  await scenario("S2 broken-fails-same-oracle", async (own) => {
    await createRun("r-broken", [CART_RULE]);
    const { cdp, sessionId } = await pageFor("r-broken");
    own("r-broken", cdp);
    const { dom } = await loadCart(cdp, sessionId, "/broken/");
    const s = await stats("r-broken");
    return {
      ...judge({ dom, stats: s?.stats, upstream: s?.upstream, expect: cartExpect("/broken/") }, { code: "dom-mismatch", own: BROKEN_OWN }),
      dom,
      stats: s?.stats,
      upstream: s?.upstream,
    };
  });

  // S3: a rule whose URL does not exist. The page shows ok:3, and the oracle
  // still has to say the fault was never injected.
  await scenario("S3 missing-url-not-injected", async (own) => {
    await createRun("r-missing", [{ ...CART_RULE, urlPattern: "^https://shop\\.invalid/api/does-not-exist$" }]);
    const { cdp, sessionId } = await pageFor("r-missing");
    own("r-missing", cdp);
    const { dom } = await loadCart(cdp, sessionId, "/correct/");
    const s = await stats("r-missing");
    return {
      ...judge({ dom, stats: s?.stats, upstream: s?.upstream, expect: cartExpect("/correct/") }, { code: "not-injected", own: MISSING_URL_OWN }),
      dom,
      stats: s?.stats,
      upstream: s?.upstream,
    };
  });

  let s5Page;
  // S4 + S5 + S8(a): two runs at once, then the same run across evaluate,
  // re-navigation and the other egress paths, then its disposal.
  await scenario("S4 two-concurrent-runs", async (own) => {
    await Promise.all([createRun("r-a", [CART_RULE]), createRun("r-b", [CART_RULE])]);
    const [a, b] = await Promise.all([pageFor("r-a"), pageFor("r-b")]);
    own("r-a", a.cdp, { beforeDelete: s8aProbes });
    own("r-b", b.cdp);
    const [la, lb] = await Promise.all([loadCart(a.cdp, a.sessionId, "/correct/"), loadCart(b.cdp, b.sessionId, "/correct/")]);
    const [sa, sb] = await Promise.all([stats("r-a"), stats("r-b")]);
    // A run has one connection for its life: a second socket on a live run
    // would share its counters and RNG, so the upgrade itself is refused.
    const secondConnection = await upgradeStatus(`${base}/devtools/browser?run=r-b`);
    const sbAfter = await stats("r-b");
    const secondReasons = [];
    if (secondConnection !== 409) secondReasons.push(`second connection on live r-b: ${secondConnection}, expected 409`);
    if (JSON.stringify(sbAfter?.stats) !== JSON.stringify(sb?.stats)) secondReasons.push(`r-b stats moved after the refused connection: ${JSON.stringify(sbAfter?.stats)}`);
    scenarios.push({ name: "S8c second-connection-refused", ok: secondReasons.length === 0, durationMs: 0, expected: "pass", result: secondReasons.length ? "fail" : "pass", matched: secondReasons.length === 0, reasons: secondReasons, secondConnection, note: "runs inside S4's r-b; teardown is S4's" });
    log(`${secondReasons.length ? "FAIL" : "ok  "} S8c second-connection-refused ${JSON.stringify({ secondConnection })}`);
    const ja = judge({ dom: la.dom, stats: sa?.stats, upstream: sa?.upstream, expect: cartExpect("/correct/") });
    const jb = judge({ dom: lb.dom, stats: sb?.stats, upstream: sb?.upstream, expect: cartExpect("/correct/") });
    s5Page = a;
    return {
      expected: "pass",
      result: ja.matched && jb.matched && secondReasons.length === 0 ? "pass" : "fail",
      matched: ja.matched && jb.matched && secondReasons.length === 0,
      reasons: [...ja.reasons.map((r) => ({ run: "r-a", ...r })), ...jb.reasons.map((r) => ({ run: "r-b", ...r })), ...secondReasons],
      dom: { "r-a": la.dom, "r-b": lb.dom },
      stats: { "r-a": sa?.stats, "r-b": sb?.stats },
      upstream: { "r-a": sa?.upstream, "r-b": sb?.upstream },
      // S5 runs inside this scenario's lifetime, before the teardown.
      s5: await s5().catch((e) => {
        scenarios.push({ name: "S5 renavigation-and-paths", ok: false, expected: "pass", result: "error", matched: false, reasons: [String(e?.stack ?? e)] });
        log(`FAIL S5 renavigation-and-paths ${e}`);
        return false;
      }),
    };
  });

  async function s5() {
    const { cdp, sessionId } = s5Page;
    const reasons = [];
    const check = (ok, what) => {
      if (!ok) reasons.push(what);
    };
    const ev = await cdp.evaluate(sessionId, "fetch('/api/cart').then(r => r.status + ' ' + r.headers.get('content-type'))");
    let s = await stats("r-a");
    check(ev.value === "200 application/json", `Runtime.evaluate fetch: ${JSON.stringify(ev)}`);
    check(s?.stats[0]?.matched === 3 && s?.stats[0]?.injected === 1, `after evaluate: ${JSON.stringify(s?.stats)}`);

    const again = await loadCart(cdp, sessionId, "/again.html");
    s = await stats("r-a");
    check(again.dom.attempts === "200" && again.dom.result === "ok:3", `re-navigation DOM: ${JSON.stringify(again.dom)}`);
    check(s?.stats[0]?.matched === 4 && s?.stats[0]?.injected === 1, `after re-navigation: ${JSON.stringify(s?.stats)}`);

    await cdp.navigate(sessionId, `${ORIGIN}/ws.html`);
    const wsText = await cdp
      .waitFor(sessionId, "document.getElementById('ws')?.textContent", (v) => typeof v === "string" && v !== "pending", 20_000)
      .catch((e) => String(e));
    s = await stats("r-a");
    check(wsText === "msg:echo:ping", `WebSocket (globalOutbound): ${wsText}`);
    check(s?.upstream["/ws"] === 1, `upstream /ws: ${s?.upstream["/ws"]}`);

    await cdp.navigate(sessionId, `${ORIGIN}/worker.html`);
    const wText = await cdp
      .waitFor(sessionId, "document.getElementById('w')?.textContent", (v) => typeof v === "string" && v !== "pending", 20_000)
      .catch((e) => String(e));
    s = await stats("r-a");
    check(typeof wText === "string" && wText.includes("/api/from-worker"), `dedicated worker: ${wText}`);
    check(s?.upstream["/api/from-worker"] === 1, `upstream /api/from-worker: ${s?.upstream["/api/from-worker"]}`);

    const r = { expected: "pass", result: reasons.length ? "fail" : "pass", matched: reasons.length === 0, reasons, ws: wsText, worker: wText, stats: s?.stats, upstream: s?.upstream };
    scenarios.push({ name: "S5 renavigation-and-paths", ok: r.matched, durationMs: 0, ...r, note: "runs inside S4's r-a; teardown is S4's" });
    log(`${r.matched ? "ok  " : "FAIL"} S5 renavigation-and-paths${r.matched ? "" : ` ${JSON.stringify(reasons)}`}`);
    return r.matched;
  }

  // S8(a), run by r-a's teardown between dispose and delete.
  async function s8aProbes() {
    const problems = [];
    const results = {
      upgradeAfterDispose: await upgradeStatus(`${base}/devtools/browser?run=r-a`),
      upgradeWithoutRun: await upgradeStatus(`${base}/devtools/browser`),
      secondDispose: (await ctl("dispose", { run: "r-a" })).status,
    };
    if (results.upgradeAfterDispose !== 409) problems.push(`upgrade after dispose: ${results.upgradeAfterDispose}, expected 409`);
    if (results.upgradeWithoutRun !== 400) problems.push(`upgrade without run: ${results.upgradeWithoutRun}, expected 400`);
    if (results.secondDispose !== 200) problems.push(`second dispose: ${results.secondDispose}, expected 200`);
    scenarios.push({ name: "S8a dispose-refuses-reconnect", ok: problems.length === 0, expected: "pass", result: problems.length ? "fail" : "pass", matched: problems.length === 0, reasons: problems, ...results });
    log(`${problems.length ? "FAIL" : "ok  "} S8a dispose-refuses-reconnect ${JSON.stringify(results)}`);
    // Reported in its own record; returned here too so r-a's teardown fails with it.
    return problems;
  }

  // S6: an abort fault is a failed fetch, not an HTTP 503.
  await scenario("S6 abort-fault", async (own) => {
    const rule = { name: "abort-once", urlPattern: "^https://shop\\.invalid/api/abort$", methods: ["GET"], fault: { kind: "abort" }, schedule: { decisions: ["inject"] } };
    await createRun("r-abort", [rule]);
    const { cdp, sessionId } = await pageFor("r-abort");
    own("r-abort", cdp);
    await loadCart(cdp, sessionId, "/again.html");
    const ev = await cdp.evaluate(sessionId, "fetch('/api/abort').then(r => 'resolved ' + r.status, e => 'rejected ' + e.name)");
    const s = await stats("r-abort");
    gate.injectedAborts += s?.stats.find((x) => x.rule === "abort-once")?.injected ?? 0;
    const reasons = [];
    if (ev.value !== "rejected TypeError") reasons.push(`page: ${JSON.stringify(ev)}`);
    if ((s?.upstream["/api/abort"] ?? 0) !== 0) reasons.push(`upstream /api/abort: ${s?.upstream["/api/abort"]}`);
    if (s?.stats[0]?.injected !== 1) reasons.push(`stats: ${JSON.stringify(s?.stats)}`);
    return { expected: "pass", result: reasons.length ? "fail" : "pass", matched: reasons.length === 0, reasons, page: ev, stats: s?.stats, upstream: s?.upstream };
  });

  // S7: a URL the engine's filter rejects never reaches egress, even with a
  // rule that would fault every request to it.
  await scenario("S7 filter-never-reaches-transport", async (own) => {
    const rule = { name: "blocked-503", urlPattern: "^https://shop\\.invalid/api/blocked$", fault: { kind: "status", status: 503 }, probability: 1 };
    await createRun("r-filter", [rule]);
    const { cdp, sessionId } = await pageFor("r-filter");
    own("r-filter", cdp);
    await loadCart(cdp, sessionId, "/again.html");
    const filter = await cdp.send("Kitesurf.setOutboundFilters", { rejectRequestPattern: ["/api/blocked"] });
    const blocked = await cdp.evaluate(sessionId, "fetch('/api/blocked').then(r => r.status, e => 'rejected ' + e.name)");
    const after = await cdp.evaluate(sessionId, "fetch('/api/after-filter').then(r => r.status, e => 'rejected ' + e.name)");
    const s = await stats("r-filter");
    const reasons = [];
    if (filter?.ok !== true) reasons.push(`setOutboundFilters: ${JSON.stringify(filter)}`);
    if (blocked.value !== 451) reasons.push(`blocked fetch: ${JSON.stringify(blocked)}`);
    if (s?.stats[0]?.matched !== 0 || s?.stats[0]?.injected !== 0) reasons.push(`stats: ${JSON.stringify(s?.stats)}`);
    if ((s?.upstream["/api/blocked"] ?? 0) !== 0) reasons.push(`upstream /api/blocked: ${s?.upstream["/api/blocked"]}`);
    if (after.value !== 200 || s?.upstream["/api/after-filter"] !== 1) reasons.push(`after filter: ${JSON.stringify(after)} upstream ${s?.upstream["/api/after-filter"]}`);
    return { expected: "pass", result: reasons.length ? "fail" : "pass", matched: reasons.length === 0, reasons, blocked, after, stats: s?.stats, upstream: s?.upstream };
  });

  // S8(b): the run disappears while its socket is open. The page's fetch
  // must fail loudly; nothing may fall back to a fresh session or pass-through.
  await scenario("S8b run-lost", async (own) => {
    await createRun("r-lost", [CART_RULE]);
    const { cdp, sessionId } = await pageFor("r-lost");
    own("r-lost", cdp, { lost: true });
    await loadCart(cdp, sessionId, "/again.html");
    const deleted = await ctl("delete", { run: "r-lost" });
    gate.runLostIds.push("r-lost");
    const ev = await cdp.evaluate(sessionId, "fetch('/api/cart').then(r => 'resolved ' + r.status, e => 'rejected ' + e.name)");
    const nav = await cdp.navigate(sessionId, `${ORIGIN}/again.html`).catch((e) => ({ error: String(e) }));
    const reasons = [];
    if (deleted.status !== 200) reasons.push(`delete: ${deleted.status}`);
    if (ev.value !== "rejected TypeError") reasons.push(`page fetch: ${JSON.stringify(ev)}`);
    if (!String(nav?.errorText ?? nav?.error ?? "").includes("run-lost")) reasons.push(`navigate: ${JSON.stringify(nav)}`);
    return { expected: "pass", result: reasons.length ? "fail" : "pass", matched: reasons.length === 0, reasons, page: ev, navigate: nav };
  });

  const slowRule = (ms) => ({ name: `slow-${ms}`, urlPattern: "^https://shop\\.invalid/api/slow$", methods: ["GET"], fault: { kind: "delay", ms }, probability: 1 });

  // S9(a): a delay holds the request, then lets it through once.
  await scenario("S9a delay", async (own) => {
    await createRun("r-delay", [slowRule(300)]);
    const { cdp, sessionId } = await pageFor("r-delay");
    own("r-delay", cdp);
    await loadCart(cdp, sessionId, "/again.html");
    const ev = await cdp.evaluate(sessionId, "(async () => { const t = performance.now(); const r = await fetch('/api/slow'); return { status: r.status, ms: performance.now() - t }; })()");
    const s = await stats("r-delay");
    const reasons = [];
    if (ev.value?.status !== 200) reasons.push(`page: ${JSON.stringify(ev)}`);
    if (!(ev.value?.ms >= 300)) reasons.push(`resolved after ${ev.value?.ms} ms, before the 300 ms delay`);
    if (s?.upstream["/api/slow"] !== 1) reasons.push(`upstream /api/slow: ${s?.upstream["/api/slow"]}`);
    return { expected: "pass", result: reasons.length ? "fail" : "pass", matched: reasons.length === 0, reasons, page: ev.value, stats: s?.stats, upstream: s?.upstream };
  });

  // S9(b): the CDP socket closes while a delay is pending. Needs
  // enable_request_signal: the cancelled call's Request.signal must fire so
  // the wait ends and upstream is never called.
  await scenario("S9b delay-then-socket-close", async (own) => {
    await createRun("r-close", [slowRule(4000)]);
    const { cdp, sessionId } = await pageFor("r-close");
    own("r-close", cdp);
    await loadCart(cdp, sessionId, "/again.html");
    const t0 = Date.now();
    await cdp.evaluate(sessionId, "window.__slow = fetch('/api/slow').then(r => r.status, e => 'rejected'); 1", { awaitPromise: false });
    await sleep(800);
    const during = await stats("r-close");
    await cdp.close();
    const ended = await statsUntil("r-close", (s) => s.sessionEnds.length > 0 && s.inFlight === 0);
    await sleep(Math.max(0, 5_000 - (Date.now() - t0)));
    const late = await stats("r-close");
    const reasons = [];
    if (during?.inFlight !== 1) reasons.push(`in flight before close: ${during?.inFlight}, expected 1`);
    if (!ended?.sessionEnds.length) reasons.push("no session_end after close");
    if (ended?.inFlight !== 0) reasons.push(`still in flight after close: ${ended?.inFlight}`);
    // The wait ended because Request.signal fired (enable_request_signal),
    // not because the delay ran out.
    if (ended?.callerCancelled !== 1) reasons.push(`caller cancellations seen by the host: ${ended?.callerCancelled}, expected 1`);
    if ((late?.upstream["/api/slow"] ?? 0) !== 0) reasons.push(`upstream /api/slow after the delay would have ended: ${late?.upstream["/api/slow"]}`);
    return {
      expected: "pass",
      result: reasons.length ? "fail" : "pass",
      matched: reasons.length === 0,
      reasons,
      inFlightBeforeClose: during?.inFlight,
      sessionEnds: ended?.sessionEnds,
      upstream: late?.upstream,
      stats: late?.stats,
    };
  });

  // S9(c): a host-side dispose while the socket is still open ends a pending
  // delay across the RPC boundary, before it reaches upstream.
  await scenario("S9c delay-then-dispose", async (own) => {
    await createRun("r-dispose", [slowRule(4000)]);
    const { cdp, sessionId } = await pageFor("r-dispose");
    own("r-dispose", cdp);
    await loadCart(cdp, sessionId, "/again.html");
    const t0 = Date.now();
    await cdp.evaluate(sessionId, "window.__slow = fetch('/api/slow').then(r => 'resolved ' + r.status, e => 'rejected ' + e.name); 1", { awaitPromise: false });
    await sleep(800);
    const during = await stats("r-dispose");
    const disposed = await ctl("dispose", { run: "r-dispose" });
    const page = await cdp.evaluate(sessionId, "window.__slow");
    const pageMs = Date.now() - t0;
    const after = await statsUntil("r-dispose", (s) => s.inFlight === 0);
    await sleep(Math.max(0, 5_000 - (Date.now() - t0)));
    const late = await stats("r-dispose");
    const reasons = [];
    if (during?.inFlight !== 1) reasons.push(`in flight before dispose: ${during?.inFlight}, expected 1`);
    if (disposed.status !== 200) reasons.push(`dispose: ${disposed.status}`);
    if (page.value !== "rejected TypeError") reasons.push(`page: ${JSON.stringify(page)}`);
    if (!(pageMs < 4_000)) reasons.push(`page settled after ${pageMs} ms: the dispose did not cut the delay short`);
    if (after?.inFlight !== 0) reasons.push(`still in flight after dispose: ${after?.inFlight}`);
    if (after?.disposedInFlight !== 1) reasons.push(`calls cut short by the dispose: ${after?.disposedInFlight}, expected 1`);
    if ((late?.upstream["/api/slow"] ?? 0) !== 0) reasons.push(`upstream /api/slow: ${late?.upstream["/api/slow"]}`);
    return { expected: "pass", result: reasons.length ? "fail" : "pass", matched: reasons.length === 0, reasons, page: page.value, pageMs, upstream: late?.upstream, stats: late?.stats };
  });

  return { scenarios, gate };
}
