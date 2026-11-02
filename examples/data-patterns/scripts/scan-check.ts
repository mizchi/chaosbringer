/**
 * How much of the catalog `chaosbringer scan` finds.
 *
 * The catalog's own test hands chaosbringer the bad data and knows what to
 * look for. A scan of an unknown site does neither: it takes no fault rules
 * (`runScan` omits `faultInjection`), and runs no data-safety check unless
 * told to. So this serves the bad data through what scan can reach (a
 * response entry's route answers with the bad body itself; a query rides on
 * the URL; storage and form data go in as `crawler.lifecycleFaults` and
 * `crawler.driver`) and scans every variant twice: as it comes, and with the
 * catalog suite as `crawler.invariants`.
 *
 * A variant is **flagged** when a `bug` finding matches the entry's signal:
 * an error by a `js-exception` / `unhandled-rejection` finding whose title
 * matches the message, an invariant by an `invariant-violation` finding whose
 * title names it (`Invariant violated: [data.xss-marker] …`) and matches the
 * signal's message when it has one. A blocked
 * navigation is in the crawl report only; no scan rule reads it.
 *
 *   pnpm scan-check                     # every entry; rewrites the README section
 *   PATTERN=null-relation pnpm scan-check
 *
 * Exits 1 when a fixed variant is still flagged or an oracle entry has any
 * bug finding.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CrawlerOptions, runScan, type ScanFinding } from "chaosbringer";
import { describeInjection, toCrawlOptions, toServedRoutes } from "../src/inject.js";
import type { DataPattern, Signal, Variant } from "../src/pattern.js";
import { loadPatterns } from "../src/registry.js";
import { servePattern } from "../src/server.js";
import { catalogSuite } from "../src/suite.js";

const readme = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const START = "<!-- scan-check:start -->";
const END = "<!-- scan-check:end -->";

/** The bug findings of one scan of one variant on its bad data. */
async function scanVariant(pattern: DataPattern, variant: Variant, withSuite: boolean): Promise<ScanFinding[]> {
  const oracle = pattern.inject.channel === "none";
  const server = await servePattern(pattern, variant, (v, ctx) => toServedRoutes(pattern, v, ctx));
  const outDir = mkdtempSync(join(tmpdir(), `scan-check-${pattern.id}-`));
  const c = pattern.crawl ?? {};
  try {
    const injected = toCrawlOptions(pattern, oracle ? "none" : "bad", server.ctx);
    // The response channel is served above; scan takes the rest as crawler options.
    const { faultInjection: _served, ...reachable } = injected.options;
    // Less the keys scan sets itself, which its `crawler` option leaves out.
    const {
      baseUrl: _baseUrl,
      perf: _perf,
      faultInjection: _faults,
      seed: _seed,
      maxPages: _maxPages,
      maxActionsPerPage: _maxActions,
      ...options
    }: Partial<CrawlerOptions> = c.options ?? {};
    const result = await runScan({
      url: server.origin + (c.entry ?? "/") + injected.query,
      seed: c.seed ?? 1,
      maxPages: 1,
      maxActionsPerPage: c.maxActionsPerPage ?? 0,
      outDir,
      chaos: false,
      coverage: false,
      crawler: {
        headless: true,
        logLevel: "error",
        ...(withSuite ? { invariants: catalogSuite() } : {}),
        ...(c.actionWeights ? { actionWeights: c.actionWeights } : {}),
        ...reachable,
        ...options,
      },
    });
    return result.analysis.findings.filter((f) => f.category === "bug");
  } finally {
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** The finding that reports `signal`, if any. */
function flaggedBy(findings: ScanFinding[], signal: Signal): ScanFinding | undefined {
  switch (signal.kind) {
    case "error":
      return findings.find((f) => (f.rule === "js-exception" || f.rule === "unhandled-rejection") && f.title.search(signal.message) !== -1);
    case "invariant": {
      const message = signal.message;
      return findings.find(
        (f) =>
          f.rule === "invariant-violation" &&
          f.title.includes(`[${signal.name}]`) &&
          (message === undefined || f.title.search(message) !== -1),
      );
    }
    case "blocked-navigation":
      return undefined;
  }
}

interface Row {
  pattern: DataPattern;
  signal: Signal;
  outOfTheBox?: string;
  withSuite?: string;
  /** Every bug rule the fixed variant raised, not only the entry's own signal. */
  fixed: string[];
  rules: string[];
}

const patterns = await loadPatterns();
const rows: Row[] = [];
const oracles: Array<{ pattern: DataPattern; findings: ScanFinding[] }> = [];
for (const p of patterns) {
  process.stderr.write(`scan-check ${p.id} …`);
  if (p.expect.signal === "none") {
    const findings = await scanVariant(p, "fixed", true);
    oracles.push({ pattern: p, findings });
    process.stderr.write(` oracle: ${findings.map((f) => f.rule).join(",") || "clean"}\n`);
    continue;
  }
  const signal = p.expect.signal;
  const plain = await scanVariant(p, "buggy", false);
  const suite = await scanVariant(p, "buggy", true);
  const fixed = [...(await scanVariant(p, "fixed", false)), ...(await scanVariant(p, "fixed", true))];
  const row: Row = {
    pattern: p,
    signal,
    outOfTheBox: flaggedBy(plain, signal)?.rule,
    withSuite: flaggedBy(suite, signal)?.rule,
    // A fix is held to the same bar as an oracle: no bug finding at all, not
    // just none matching its own signal, so a fix that trades its bug for
    // another one is caught too.
    fixed: [...new Set(fixed.map((f) => f.rule))].sort(),
    rules: [...new Set([...plain, ...suite].map((f) => f.rule))].sort(),
  };
  process.stderr.write(` out of the box: ${row.outOfTheBox ?? "-"} | with the suite: ${row.withSuite ?? "-"} | fixed: ${row.fixed.join(",") || "-"}\n`);
  rows.push(row);
}

const code = (x: string | undefined) => (x ? `\`${x}\`` : "–");
const codes = (xs: string[]) => (xs.length ? xs.map(code).join(", ") : "–");
// No scan rule reads a blocked navigation: say so rather than show a miss.
const flagCell = (r: Row, rule: string | undefined) => (r.signal.kind === "blocked-navigation" ? "– (report field only)" : code(rule));
const outOfTheBox = rows.filter((r) => r.outOfTheBox).length;
const withSuite = rows.filter((r) => r.withSuite).length;
const fixedFlagged = rows.filter((r) => r.fixed.length > 0).length;
const oraclesFlagged = oracles.filter((o) => o.findings.length > 0);
const lines = [
  `Measured by \`pnpm scan-check\` on ${new Date().toISOString().slice(0, 10)}: \`runScan\` with \`chaos: false\`, one page, the entry's seed and actions, on the bad data.`,
  "",
  `**${outOfTheBox} of ${rows.length}** buggy variants are flagged out of the box, **${withSuite} of ${rows.length}** with the catalog suite as \`crawler.invariants\`; **${fixedFlagged}** fixed variants are still flagged.`,
  "",
  "| entry | data via | buggy: out of the box | buggy: with `invariants.dataSafety()` + `notBlank()` | fixed: still flagged | every bug rule on buggy |",
  "|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| [${r.pattern.id}](src/patterns/${r.pattern.id}.ts) | ${describeInjection(r.pattern)} | ${flagCell(r, r.outOfTheBox)} | ${flagCell(r, r.withSuite)} | ${codes(r.fixed)} | ${codes(r.rules)} |`,
  ),
];
if (oracles.length > 0) {
  lines.push(
    "",
    `Oracle entries, scanned once with the suite: ${oracles
      .map((o) => `[${o.pattern.id}](src/patterns/${o.pattern.id}.ts) ${o.findings.length ? codes([...new Set(o.findings.map((f) => f.rule))]) : "clean"}`)
      .join(", ")}.`,
  );
}
const table = lines.join("\n");

const text = readFileSync(readme, "utf-8");
const s = text.indexOf(START);
const e = text.indexOf(END);
if (s === -1 || e === -1) throw new Error(`README.md has no ${START} / ${END} markers`);
if (process.env.PATTERN) {
  console.log(table);
} else {
  writeFileSync(readme, `${text.slice(0, s + START.length)}\n${table}\n${text.slice(e)}`);
  console.log(`README.md: ${outOfTheBox}/${rows.length} out of the box, ${withSuite}/${rows.length} with the suite, ${fixedFlagged} fixed flagged`);
}
if (fixedFlagged > 0 || oraclesFlagged.length > 0) {
  console.error(
    `scan-check: flagged where nothing is wrong: ${[
      ...rows.filter((r) => r.fixed.length > 0).map((r) => `${r.pattern.id} (fixed: ${r.fixed.join(",")})`),
      ...oraclesFlagged.map((o) => `${o.pattern.id} (${[...new Set(o.findings.map((f) => f.rule))].join(",")})`),
    ].join(", ")}`,
  );
  process.exitCode = 1;
}
