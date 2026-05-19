/**
 * cleanup-eval.ts — kill any leftover probe loops + remove the
 * eval-time variant landing pad (#121, #128).
 *
 * Usage:
 *   pnpm cleanup-eval              — kill all known probe loops + tidy
 *   pnpm cleanup-eval --keep-workdirs — kill loops only, keep /tmp dirs
 *
 * Run between eval batches to leave the env clean.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const keepWorkdirs = process.argv.includes("--keep-workdirs");
const HERE = resolve(import.meta.dirname, "..");

let killed = 0;
for (const entry of readdirSync("/tmp")) {
  if (!entry.startsWith("wom-")) continue;
  const dir = join("/tmp", entry);
  const pidFile = join(dir, "probe.pid");
  if (existsSync(pidFile)) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
          killed++;
          console.log(`killed probe loop pid=${pid} (${dir})`);
        } catch {
          /* already gone */
        }
      }
      try { unlinkSync(pidFile); } catch { /* ignore */ }
    } catch {
      /* malformed; ignore */
    }
  }
}

// Remove the gitignored eval-time variant landing pad.
const liveSrc = join(HERE, "target/src/server.live.ts");
if (existsSync(liveSrc)) {
  try {
    rmSync(liveSrc);
    console.log(`removed ${liveSrc}`);
  } catch (err) {
    console.error(`failed to remove ${liveSrc}: ${err}`);
  }
}

if (!keepWorkdirs) {
  // Optional: leave the /tmp/wom-* dirs in place by default; they
  // contain journals + reports useful for review. --keep-workdirs
  // is the no-op default; pass --rm-workdirs to also delete.
}
if (process.argv.includes("--rm-workdirs")) {
  for (const entry of readdirSync("/tmp")) {
    if (!entry.startsWith("wom-")) continue;
    try {
      rmSync(join("/tmp", entry), { recursive: true, force: true });
      console.log(`removed /tmp/${entry}`);
    } catch { /* ignore */ }
  }
}

console.log(`done. probe loops killed: ${killed}`);
