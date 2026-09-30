/**
 * How much of the catalog `chaosbringer scan` finds on its own.
 *
 * The catalog's own test knows each pattern's metric and key and compares
 * the slow variant with the fixed one. A scan of an unknown site has
 * neither: it has to spot the problem from thresholds alone. This runs
 * `runScan` on both variants of every pattern (with the pattern's crawl
 * settings: seed, pages, actions) and counts a variant as **flagged** when
 * some finding names the pattern among its catalog matches. A slow variant
 * flagged is a hit; a fixed variant still flagged is a false alarm (or a
 * threshold the fix does not get under).
 *
 *   pnpm scan-check                     # every pattern; rewrites the README section
 *   PATTERN=layout-thrash pnpm scan-check
 *
 * The chaos crawl runs only for `chaos` patterns (the others have no API
 * failure to find, and it doubles the time).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScan, type ScanFinding } from "chaosbringer";
import type { Pattern, Variant } from "../src/pattern.js";
import { loadPatterns } from "../src/registry.js";
import { servePattern } from "../src/server.js";

const readme = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const START = "<!-- scan-check:start -->";
const END = "<!-- scan-check:end -->";

interface VariantScan {
  /** Rules whose finding names this pattern. */
  rules: string[];
  /** Every rule that fired, for the "what else it saw" column. */
  all: string[];
}

async function scanVariant(pattern: Pattern, variant: Variant): Promise<VariantScan> {
  const server = await servePattern(pattern, variant);
  const outDir = mkdtempSync(join(tmpdir(), `scan-check-${pattern.id}-`));
  const c = pattern.crawl;
  try {
    const perf = typeof c.perf === "object" ? c.perf : undefined;
    const { outDir: _outDir, ...perfRest } = perf ?? {};
    void _outDir;
    const result = await runScan({
      url: server.origin + (c.entry ?? "/"),
      seed: c.seed,
      maxPages: c.maxPages,
      maxActionsPerPage: c.maxActionsPerPage,
      outDir,
      chaos: pattern.category === "chaos",
      coverage: false,
      perf: perfRest,
      crawler: {
        headless: true,
        ...(c.settle ? { settle: c.settle } : {}),
        ...(c.actionWeights ? { actionWeights: c.actionWeights } : {}),
        ...(c.driver ? { driver: c.driver } : {}),
        ...c.options,
      },
    });
    const names = (f: ScanFinding) => f.patterns ?? [];
    return {
      rules: [...new Set(result.analysis.findings.filter((f) => names(f).includes(pattern.id)).map((f) => f.rule))].sort(),
      all: [...new Set(result.analysis.findings.map((f) => f.rule))].sort(),
    };
  } finally {
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

const patterns = await loadPatterns();
const rows: Array<{ pattern: Pattern; slow: VariantScan; fixed: VariantScan }> = [];
for (const p of patterns) {
  process.stderr.write(`scan-check ${p.id} …`);
  const slow = await scanVariant(p, "slow");
  const fixed = await scanVariant(p, "fixed");
  process.stderr.write(` slow: ${slow.rules.join(",") || "-"} | fixed: ${fixed.rules.join(",") || "-"}\n`);
  rows.push({ pattern: p, slow, fixed });
}

const code = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "–");
const hits = rows.filter((r) => r.slow.rules.length > 0).length;
const clean = rows.filter((r) => r.slow.rules.length > 0 && r.fixed.rules.length === 0).length;
const table = [
  `Measured by \`pnpm scan-check\` on ${new Date().toISOString().slice(0, 10)}: one scan per variant at the pattern's seed.`,
  "",
  `**${hits} of ${rows.length}** slow variants are flagged with their own pattern; on **${clean}** of those, the fixed variant is not.`,
  "",
  "| pattern | slow: flagged by | fixed: still flagged by | slow: every rule that fired |",
  "|---|---|---|---|",
  ...rows.map((r) => `| [${r.pattern.id}](src/patterns/${r.pattern.id}.ts) | ${code(r.slow.rules)} | ${code(r.fixed.rules)} | ${code(r.slow.all)} |`),
].join("\n");

const text = readFileSync(readme, "utf-8");
const s = text.indexOf(START);
const e = text.indexOf(END);
if (s === -1 || e === -1) throw new Error(`README.md has no ${START} / ${END} markers`);
if (process.env.PATTERN) {
  console.log(table);
} else {
  writeFileSync(readme, `${text.slice(0, s + START.length)}\n${table}\n${text.slice(e)}`);
  console.log(`README.md: ${hits}/${rows.length} flagged, ${clean} clean on the fix`);
}
