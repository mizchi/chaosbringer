/**
 * One-shot dogfood loop orchestrator.
 *
 * Spawns both server variants on their fixed ports, waits for /health
 * to come up on each, runs the suite of chaosbringer tools against
 * them, prints a summary, and tears down. Designed for sub-agent
 * invocation: a single `tsx loop.ts` produces the artefacts the agent
 * inspects (reports/, artifacts/, parity output) without the agent
 * having to manage processes.
 *
 * Usage:
 *   tsx loop.ts             # full pass (parity + chaos:v1 + chaos:v2 + diff)
 *   tsx loop.ts parity      # only parity
 *   tsx loop.ts chaos       # only chaos crawls + diff
 *
 * Exit code:
 *   0 — nothing the loop detected (no parity mismatches, no new clusters)
 *   1 — at least one tool reported a deviation. Look in reports/ and
 *       artifacts/clusters/ for evidence.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT_V1 = 5001;
const PORT_V2 = 5002;
const REPORTS = "reports";
const ARTIFACTS = "artifacts";

const mode = (process.argv[2] ?? "all") as "all" | "parity" | "chaos" | "journey";

async function waitForHealth(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`server on :${port} never became healthy`);
}

function startVariant(variant: "v1" | "v2", port: number): ChildProcess {
  const child = spawn("tsx", ["server.ts"], {
    env: { ...process.env, VARIANT: variant, PORT: String(port) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (err) => {
    console.error(`[${variant}] spawn error:`, err);
  });
  return child;
}

async function runCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "chaosbringer", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function main(): Promise<void> {
  // Fresh outputs every run so an agent looking at the directory sees
  // only what THIS pass produced — no stale clusters from a previous fix.
  rmSync(REPORTS, { recursive: true, force: true });
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(REPORTS, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const v1 = startVariant("v1", PORT_V1);
  const v2 = startVariant("v2", PORT_V2);
  let exitCode = 0;
  try {
    await Promise.all([waitForHealth(PORT_V1), waitForHealth(PORT_V2)]);

    if (mode === "all" || mode === "parity") {
      console.log("\n=== parity probe ===");
      const code = await runCli([
        "parity",
        "--left",
        `http://127.0.0.1:${PORT_V1}`,
        "--right",
        `http://127.0.0.1:${PORT_V2}`,
        "--paths",
        "paths.txt",
        "--output",
        `${REPORTS}/parity.json`,
        // Opt into body + header + browser comparison so the full
        // spectrum of seeded bug classes surfaces in one pass.
        "--check-body",
        "--check-headers",
        "content-type,cache-control",
        "--check-exceptions",
      ]);
      if (code !== 0) exitCode = 1;
    }

    if (mode === "all" || mode === "parity" || mode === "journey") {
      for (const file of ["journey-todos.json", "journey-by-id.json"]) {
        console.log(`\n=== journey: ${file} ===`);
        const code = await runCli([
          "journey",
          "--left",
          `http://127.0.0.1:${PORT_V1}`,
          "--right",
          `http://127.0.0.1:${PORT_V2}`,
          "--steps",
          file,
          "--output",
          `${REPORTS}/${file}`,
        ]);
        if (code !== 0) exitCode = 1;
      }
    }

    if (mode === "all" || mode === "chaos") {
      for (const [variant, port] of [
        ["v1", PORT_V1],
        ["v2", PORT_V2],
      ] as const) {
        console.log(`\n=== chaos crawl: ${variant} ===`);
        await runCli([
          "--url",
          `http://127.0.0.1:${port}`,
          "--seed",
          "42",
          "--max-pages",
          "8",
          "--max-actions",
          "2",
          "--output",
          `${REPORTS}/${variant}.json`,
          "--failure-artifacts",
          `${ARTIFACTS}/${variant}`,
          "--cluster-artifacts",
          "--ignore-preset",
          "analytics",
          "--compact",
        ]);
      }
      console.log("\n=== chaos diff (v1 vs v2) ===");
      const code = await runCli([
        "diff",
        `${REPORTS}/v1.json`,
        `${REPORTS}/v2.json`,
      ]);
      if (code !== 0) exitCode = 1;
    }
  } finally {
    v1.kill("SIGTERM");
    v2.kill("SIGTERM");
    // Give them a moment so the process group is gone before exit.
    await sleep(200);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("loop failed:", err);
  process.exit(2);
});
