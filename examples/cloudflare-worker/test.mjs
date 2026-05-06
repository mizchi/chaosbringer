/**
 * Smoke test for the cloudflare-worker example.
 *
 * Boots `wrangler dev` in the background, polls until the worker is ready,
 * runs `chaos/run.ts` with deterministic seeds + small page budget, and
 * asserts that server-side fault events were ingested via the response-
 * header round trip (the load-bearing wiring this example demonstrates).
 *
 * Designed for CI: tears down the worker on every exit path, has a
 * timeout on the readiness probe, and exits non-zero on any failure.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8788; // off the default to avoid colliding with a manual `pnpm dev` next door
const READY_URL = `http://localhost:${PORT}/`;
const READY_TIMEOUT_MS = 60_000;

let chaosStdout = "";

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(READY_URL);
      if (r.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(500);
  }
  throw new Error(`worker not ready within ${READY_TIMEOUT_MS}ms`);
}

// wrangler does NOT auto-forward `process.env` into the Worker — vars come
// from `wrangler.toml`'s [vars] block or from `--var KEY:VALUE` flags. We
// pass the chaos config via --var so the test is self-contained without
// mutating wrangler.toml.
const wrangler = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--port",
    String(PORT),
    "--var",
    "CHAOS_5XX_RATE:0.5",
    "--var",
    "CHAOS_LATENCY_RATE:0.2",
    "--var",
    "CHAOS_LATENCY_MS:100",
    "--var",
    "CHAOS_SEED:42",
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
    },
  },
);

let teardownCalled = false;
async function teardown(code) {
  if (teardownCalled) return;
  teardownCalled = true;
  try {
    wrangler.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  // SIGTERM grace, then hard kill
  await sleep(500);
  try {
    wrangler.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  process.exit(code);
}
process.on("SIGINT", () => teardown(130));
process.on("SIGTERM", () => teardown(143));

try {
  await waitForReady();
  console.log("[test] worker ready, running chaos…");

  await new Promise((resolve, reject) => {
    const chaos = spawn("pnpm", ["exec", "tsx", "chaos/run.ts"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        MAX_PAGES: "5",
        SEED_TODOS: "3",
        SEED: "42",
        BASE_URL: `http://localhost:${PORT}`,
      },
    });
    chaos.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      chaosStdout += s;
      process.stdout.write(s);
    });
    chaos.on("exit", () => resolve()); // exit code intentionally ignored — high fault rate may trip invariants; we assert via stdout instead
    chaos.on("error", reject);
  });

  // Assertion: the load-bearing wiring (metadataHeader → page.on("response") → report.serverFaults) actually delivered events.
  const m = chaosStdout.match(/server-side fault events:\s*(\d+)/);
  if (!m) {
    throw new Error("could not find 'server-side fault events: N' in chaos output — did the report formatting change?");
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`expected server-side fault events > 0 with CHAOS_5XX_RATE=0.5, got ${n}`);
  }
  console.log(`[test] PASS — ${n} server-side fault events observed via header round-trip`);
  await teardown(0);
} catch (err) {
  console.error("[test] FAIL:", err.message ?? err);
  await teardown(1);
}
