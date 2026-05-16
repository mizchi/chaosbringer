/**
 * Shared bootstrap: spawn kumo (with chaos enabled + #667 latency baseline),
 * spawn the target app, wait for both to be ready, return cleanup handles.
 *
 * Both processes are spawned via `child_process.spawn` so we can stream their
 * logs to predictable files. The AI agent reads `/tmp/target.log` directly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface BootResult {
  kumo: ChildProcess;
  target: ChildProcess;
  kumoEndpoint: string;
  targetUrl: string;
  shutdown: () => Promise<void>;
}

export interface BootOptions {
  /** Absolute path to a kumo binary. Defaults to env KUMO_BIN or "kumo". */
  kumoBin?: string;
  /** Path to the #667 latency config to load on startup. */
  latencyConfig?: string;
  /** Port for the target app. */
  targetPort?: number;
  /** Where to stream logs. */
  logDir?: string;
}

export async function boot(opts: BootOptions = {}): Promise<BootResult> {
  const kumoBin = opts.kumoBin ?? process.env.KUMO_BIN ?? "kumo";
  const latencyConfig = opts.latencyConfig ?? resolve(import.meta.dirname, "../kumo/latency-baseline.json");
  const targetPort = opts.targetPort ?? 3000;
  const logDir = opts.logDir ?? "/tmp";

  // 1. Spawn kumo with chaos endpoints enabled.
  const kumoLog = createWriteStream(`${logDir}/kumo.log`);
  const kumoEnv = {
    ...process.env,
    KUMO_CHAOS_ENABLED: "1",
    KUMO_LATENCY_CONFIG: existsSync(latencyConfig) ? latencyConfig : "",
  };
  const kumo = spawn(kumoBin, [], { env: kumoEnv, stdio: ["ignore", "pipe", "pipe"] });
  kumo.stdout.pipe(kumoLog);
  kumo.stderr.pipe(kumoLog);

  await waitFor(() => probeOnce("http://localhost:4566/health"), 30_000, "kumo");

  // The chaos endpoint isn't part of kumo's standard surface, so confirm
  // the patched binary is actually in use before continuing — otherwise
  // drills would fail later with confusing 404s.
  const chaosReady = await probeOnce("http://localhost:4566/kumo/chaos/rules");
  if (!chaosReady) {
    kumo.kill();
    throw new Error(
      "kumo /kumo/chaos/rules returned 404 — is the kumo-chaos-patch applied to your kumo build?",
    );
  }

  // 2. Spawn target app pointing at kumo.
  const targetLog = createWriteStream(`${logDir}/target.log`);
  const target = spawn("npx", ["tsx", resolve(import.meta.dirname, "../target/src/server.ts")], {
    env: {
      ...process.env,
      AWS_ENDPOINT_URL: "http://localhost:4566",
      PORT: String(targetPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  target.stdout.pipe(targetLog);
  target.stderr.pipe(targetLog);

  await waitFor(
    () => probeOnce(`http://localhost:${targetPort}/`),
    30_000,
    "target",
  );

  return {
    kumo,
    target,
    kumoEndpoint: "http://localhost:4566",
    targetUrl: `http://localhost:${targetPort}`,
    shutdown: async () => {
      target.kill("SIGTERM");
      kumo.kill("SIGTERM");
      await Promise.all([waitForExit(target), waitForExit(kumo)]);
    },
  };
}

async function probeOnce(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    // For the chaos endpoint we just need NOT 404 — 200 with empty rules is fine.
    return res.status !== 404;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, name: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not become ready within ${timeoutMs}ms`);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => child.once("exit", () => r()));
}
