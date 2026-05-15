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
 *   tsx loop.ts                          # full pass
 *   tsx loop.ts parity                   # only parity
 *   tsx loop.ts chaos                    # only chaos crawls + diff
 *   tsx loop.ts --expect-mismatches 10   # CI gate: exit 0 iff count==10
 *
 * Exit code:
 *   0 — nothing the loop detected (no parity mismatches, no new
 *       clusters); OR `--expect-mismatches N` was supplied and the
 *       observed mismatch count matched N exactly (the CI baseline
 *       upheld).
 *   1 — at least one tool reported a deviation (default mode) OR
 *       the observed mismatch count did not match `--expect-mismatches`.
 *       Look in reports/ and artifacts/clusters/ for evidence.
 *   2 — bad CLI usage (invalid flag value).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const PORT_V1 = 5001;
const PORT_V2 = 5002;
const REPORTS = "reports";
const ARTIFACTS = "artifacts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "expect-mismatches": { type: "string" },
  },
  allowPositionals: true,
});

const mode = (positionals[0] ?? "all") as "all" | "parity" | "chaos" | "journey";
// `--expect-mismatches N` flips the exit-code semantics: a successful
// CI run is one where the playground catches *exactly* N mismatches
// (the seeded baseline), not zero. Without the flag the loop behaves
// as before — exit 1 on any deviation, useful for local "did I break
// detection" runs.
let expectMismatches: number | null = null;
if (values["expect-mismatches"] !== undefined) {
  const n = parseInt(values["expect-mismatches"], 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `loop: --expect-mismatches must be a non-negative integer (got ${values["expect-mismatches"]})`,
    );
    process.exit(2);
  }
  expectMismatches = n;
}

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
        // Single-sample wall-clock on a loaded CI runner is too noisy
        // for a hard-pass gate: a cold-start blip on v1 alone can hide
        // BUG-9 (v2 sleeps 120ms), and noise on an unrelated path can
        // trip a false-positive. Use the N-sample percentile mode the
        // sibling parity feature in this same package adds — 5 samples
        // at p95 reduces both directions of flake to negligible while
        // BUG-9's 120ms floor still trips the 50ms threshold.
        "--perf-delta-ms",
        "50",
        "--perf-samples",
        "5",
        "--perf-percentile",
        "p95",
      ]);
      if (code !== 0) exitCode = 1;
    }

    if (mode === "all" || mode === "parity" || mode === "journey") {
      for (const file of [
        "journey-todos.json",
        "journey-by-id.json",
        "journey-tenant-isolation.json",
      ]) {
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
  const summary = printSummary();
  // `--expect-mismatches` mode flips the exit code: success means the
  // playground caught exactly the expected number of seeded bugs. A
  // regression that drops detection (count too low) or one that adds
  // false positives (count too high) both fail the gate.
  if (expectMismatches !== null) {
    if (summary.mismatches === expectMismatches) {
      console.log(
        `\n[OK] expected ${expectMismatches} mismatch(es), got ${summary.mismatches}`,
      );
      process.exit(0);
    } else {
      console.log(
        `\n[FAIL] expected ${expectMismatches} mismatch(es), got ${summary.mismatches}`,
      );
      process.exit(1);
    }
  }
  process.exit(exitCode);
}

interface SummaryCounts {
  /** Number of distinct mismatch probes (one entry per path/step pair). */
  mismatches: number;
  /** Sum of all `kinds[]` firings across all probes — strictly >= mismatches. */
  kindOccurrences: number;
}

/**
 * Read every JSON report under `reports/` and tally up mismatches by
 * `MismatchKind`. Prints a table at the end of the loop so an
 * operator (or sub-agent) sees the overall shape at a glance —
 * useful as the CI gate's "did this run get worse" signal. Returns
 * the count so `--expect-mismatches` can gate on it without re-reading
 * the files.
 */
function printSummary(): SummaryCounts {
  if (!existsSync(REPORTS)) return { mismatches: 0, kindOccurrences: 0 };
  type ReportShape = {
    mismatches?: Array<{ kinds?: string[]; path?: string; label?: string }>;
  };
  const counts = new Map<string, number>();
  const detail: Array<{ source: string; where: string; kinds: string[] }> = [];
  const reports = ["parity.json", "journey-todos.json", "journey-by-id.json", "journey-tenant-isolation.json"];
  for (const name of reports) {
    const path = `${REPORTS}/${name}`;
    if (!existsSync(path)) continue;
    let parsed: ReportShape;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8")) as ReportShape;
    } catch {
      continue;
    }
    for (const m of parsed.mismatches ?? []) {
      const where = m.path ?? m.label ?? "?";
      const kinds = m.kinds ?? [];
      detail.push({ source: name, where, kinds });
      for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let kindOccurrences = 0;
  for (const n of counts.values()) kindOccurrences += n;
  if (counts.size === 0) {
    console.log("\n=== summary === no mismatches");
    return { mismatches: 0, kindOccurrences: 0 };
  }
  console.log("\n=== summary ===");
  // Stable order: by precedence-ish then alphabetical.
  const order = ["status", "failure", "redirect", "header", "body", "exception", "perf"];
  const sortedKinds = Array.from(counts.keys()).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  for (const k of sortedKinds) {
    console.log(`  ${k.padEnd(10)} ${counts.get(k)}`);
  }
  // Two numbers, not one: a header+body bug on the same path is 1
  // mismatch but 2 kind-occurrences. The original printout used
  // detail.length for both — wrong, and hid that distinction.
  console.log(
    `  ${"TOTAL".padEnd(10)} ${detail.length} mismatch(es) across ${kindOccurrences} kind-occurrence(s)`,
  );
  return { mismatches: detail.length, kindOccurrences };
}

main().catch((err) => {
  console.error("loop failed:", err);
  process.exit(2);
});
