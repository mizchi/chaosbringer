/**
 * Reference RehearsalTarget implementation (issue #118).
 *
 * Wraps the bundled Hono target as a RehearsalTarget so users can study
 * the contract end-to-end before writing their own. Exposes:
 *   - boot()       — spawns the variant via `tsx <variantSrc>`
 *   - shutdown()   — SIGTERM the child, waits for exit
 *   - restart()    — shutdown + boot
 *   - customerUrl  — http://localhost:<port>/orders
 *   - probeUrl     — http://localhost:<port>/health
 *   - verifyUrl(id) — http://localhost:<port>/verify/<id>
 *   - sourceRoots  — target/src
 *   - logStream()  — line-buffered async iterator over stdout+stderr
 *
 * Variant selection (silent-loss / dup-prone / fragile / …) is done by
 * choosing the `variantSrc` path the factory spawns. The harness's
 * eval-prepare.ts swaps that via the existing reset-target.sh — this
 * factory just spawns whatever ends up at target/src/server.ts (the
 * default). Out of scope here: a variant arg.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RehearsalTarget, TargetEnv, TargetFactory } from "@mizchi/aws-faults";

const honoReferenceTarget: TargetFactory = (env: TargetEnv): RehearsalTarget => {
  const port = env.port ?? 3000;
  let child: ChildProcess | undefined;
  const logBuf: string[] = [];
  let logResolver: ((line: string) => void) | undefined;

  function pushLog(chunk: Buffer | string) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      if (logResolver) {
        const r = logResolver;
        logResolver = undefined;
        r(line);
      } else {
        logBuf.push(line);
      }
    }
  }

  const root = resolve(import.meta.dirname);

  async function boot(): Promise<void> {
    if (child) throw new Error("already booted");
    // Spawn server.live.ts when present (eval-prepare's variant
    // landing pad, gitignored per #121) — otherwise fall back to
    // the committed baseline server.ts.
    const liveSrc = resolve(root, "server.live.ts");
    const baselineSrc = resolve(root, "server.ts");
    const src = existsSync(liveSrc) ? liveSrc : baselineSrc;
    child = spawn("npx", ["tsx", src], {
      env: {
        ...process.env,
        AWS_ENDPOINT_URL: env.awsEndpointUrl,
        PORT: String(port),
        ...(env.extraEnv ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", pushLog);
    child.stderr?.on("data", pushLog);
    await waitFor(`http://localhost:${port}/`, 30_000);
  }

  async function shutdown(): Promise<void> {
    if (!child) return;
    const c = child;
    child = undefined;
    c.kill("SIGTERM");
    if (c.exitCode === null && c.signalCode === null) {
      await new Promise<void>((r) => c.once("exit", () => r()));
    }
  }

  async function restart(): Promise<void> {
    await shutdown();
    await boot();
  }

  async function* logStream(): AsyncIterable<string> {
    while (true) {
      while (logBuf.length > 0) yield logBuf.shift()!;
      yield await new Promise<string>((r) => {
        logResolver = r;
      });
    }
  }

  return {
    boot,
    shutdown,
    restart,
    customerUrl: `http://localhost:${port}/orders`,
    probeUrl: `http://localhost:${port}/health`,
    verifyUrl: (id) => `http://localhost:${port}/verify/${encodeURIComponent(id)}`,
    sourceRoots: [resolve(root)],
    logStream,
  };
};

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status !== 404 && res.status < 500) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`target did not become ready at ${url} within ${timeoutMs}ms`);
}

export default honoReferenceTarget;
export { honoReferenceTarget };
