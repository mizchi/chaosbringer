#!/usr/bin/env node
// Run the kitesurf-faults integration on a real workerd + Kitesurf.
//
//   KITESURF_DIR=/path/to/kitesurf node scripts/run-integration.mjs
//
// Owns the whole lifecycle: checks the environment (exit 2 on anything
// missing, before starting anything), starts Kitesurf's own `wrangler dev`
// on 127.0.0.1 with this example's host Worker, runs the scenarios, stops the
// process group it started (and only that), gates on the workerd log, and
// writes artifacts/kitesurf-integration.json with the revisions and versions
// used. Exit 0 only when every scenario met its expectation, every teardown
// was complete and the log gate found nothing unexpected; 1 otherwise.
//
// Environment: KITESURF_DIR (required), KITESURF_REV (accept another
// revision; recorded), KITESURF_FAULTS_PORT (default: a free port).

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_DIR, EXIT_ENV, readManifest, setup } from "./setup-kitesurf.mjs";

const ARTIFACTS = join(EXAMPLE_DIR, "artifacts");
const log = (...a) => console.error("[integration]", ...a);
const envFail = (msg) => {
  log(msg);
  process.exit(EXIT_ENV);
};

function readWranglerConfig() {
  // JSONC: drop comments and trailing commas, enough for this file.
  const text = readFileSync(join(EXAMPLE_DIR, "wrangler.jsonc"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const git = (dir, ...args) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

function versions(kitesurfDir, wranglerBin) {
  const out = { node: process.version };
  const w = spawnSync(wranglerBin, ["--version"], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  out.wrangler = w.stdout.trim().split("\n").pop();
  try {
    const wranglerPkg = realpathSync(join(kitesurfDir, "packages/engine/node_modules/wrangler/package.json"));
    out.workerd = createRequire(wranglerPkg)("workerd/package.json").version;
  } catch (e) {
    out.workerd = `unknown (${e.message})`;
  }
  return out;
}

async function waitHealthy(base, child, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`wrangler exited (${child.exitCode ?? child.signalCode}) before it was healthy`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler was not healthy after ${timeoutMs} ms`);
}

/** Stop the process group we started: TERM, then KILL after 10 s. */
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const t = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 10_000);
  await exited;
  clearTimeout(t);
}

async function main() {
  const startedAt = new Date().toISOString();
  const setupResult = setup();
  if (!setupResult.ok) process.exit(setupResult.exitCode);
  const kitesurfDir = setupResult.dir;

  if (Number(process.versions.node.split(".")[0]) < 24) envFail(`Node ${process.version}: the CDP client needs Node 24+ (global WebSocket)`);
  const config = readWranglerConfig();
  if (!config.compatibility_flags?.includes("enable_request_signal")) {
    envFail("wrangler.jsonc must keep the enable_request_signal compatibility flag (see the comment there)");
  }
  if (!existsSync(join(EXAMPLE_DIR, "node_modules/@mizchi/kitesurf-faults/dist/index.js"))) {
    envFail("@mizchi/kitesurf-faults is not built: run `pnpm -F @mizchi/playwright-faults build && pnpm -F @mizchi/kitesurf-faults build`");
  }
  // Imported only now: both load @mizchi/kitesurf-faults, which the check
  // above has just confirmed is built.
  const { classifyWorkerdLog } = await import("../src/log-gate.ts");
  const { runChecks } = await import("./checks.mjs");
  const manifest = readManifest();
  const wranglerBin = join(kitesurfDir, manifest.wranglerBin);

  const port = Number(process.env.KITESURF_FAULTS_PORT) || (await freePort());
  const inspectorPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Per-run control token, handed over in a private env file rather than
  // --var: wrangler prints --var values in its binding table, and that table
  // lands in the log the artifact keeps.
  const token = randomBytes(16).toString("hex");
  const secretDir = mkdtempSync(join(tmpdir(), "kitesurf-faults-"));
  const envFile = join(secretDir, "control.env");
  writeFileSync(envFile, `CHAOS_CONTROL_TOKEN=${token}\n`, { mode: 0o600 });

  mkdirSync(ARTIFACTS, { recursive: true });
  const logPath = join(ARTIFACTS, "wrangler.log");
  const logFd = openSync(logPath, "w");
  const args = ["dev", "-c", "wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--env-file", envFile];
  log(`starting wrangler dev on ${base}`);
  const child = spawn(wranglerBin, args, {
    cwd: EXAMPLE_DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const onSignal = (sig) => {
    log(`${sig}: stopping wrangler`);
    stop(child).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let checks;
  let fatal;
  try {
    await waitHealthy(base, child, 120_000);
    log("healthy; running scenarios");
    checks = await runChecks({ base, token });
  } catch (e) {
    fatal = String(e?.stack ?? e);
    log(`fatal: ${fatal}`);
  } finally {
    await stop(child);
    rmSync(secretDir, { recursive: true, force: true });
  }

  const wranglerLog = readFileSync(logPath, "utf8");
  const gate = classifyWorkerdLog(wranglerLog, checks?.gate ?? { injectedAborts: 0 });
  const tokenLeaked = wranglerLog.includes(token);
  const scenarios = checks?.scenarios ?? [];
  const failed = scenarios.filter((s) => !s.ok).map((s) => s.name);

  const v = versions(kitesurfDir, wranglerBin);
  const chaosbringerDirty = git(EXAMPLE_DIR, "status", "--porcelain");
  const artifact = {
    chaosbringerRevision: git(EXAMPLE_DIR, "rev-parse", "HEAD"),
    chaosbringerDirty: Boolean(chaosbringerDirty),
    kitesurfRepo: manifest.repo,
    kitesurfRevision: setupResult.revision,
    kitesurfPinnedRevision: setupResult.pinnedRevision,
    kitesurfRevisionOverridden: setupResult.revisionOverridden,
    // As last fetched into the checkout; the runner does not fetch.
    kitesurfMainHead: git(kitesurfDir, "rev-parse", "origin/main") ?? null,
    wranglerVersion: v.wrangler,
    workerdVersion: v.workerd,
    nodeVersion: v.node,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !fatal && failed.length === 0 && scenarios.length > 0 && gate.ok && !tokenLeaked,
    fatal: fatal ?? null,
    failedScenarios: failed,
    scenarios,
    logGate: { ...gate, options: checks?.gate ?? null, tokenLeaked },
  };
  writeFileSync(join(ARTIFACTS, "kitesurf-integration.json"), `${JSON.stringify(artifact, null, 2)}\n`);

  log(`scenarios: ${scenarios.length - failed.length}/${scenarios.length} as expected${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  log(`log gate: ${gate.ok ? "clean" : gate.reasons.join("; ")}${gate.unexpected.length ? `\n  ${gate.unexpected.slice(0, 20).join("\n  ")}` : ""}`);
  if (tokenLeaked) log("the control token appears in the wrangler log");
  log(`artifact: ${join(ARTIFACTS, "kitesurf-integration.json")}`);
  process.exit(artifact.ok ? 0 : 1);
}

main().catch((e) => {
  log(`runner error: ${e?.stack ?? e}`);
  process.exit(1);
});
