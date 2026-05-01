#!/usr/bin/env node
/**
 * Fail the build when any source file contains a NUL byte (U+0000).
 *
 * Background: certain editor / agent file-write paths have silently emitted
 * NUL where a regular ASCII space was intended inside template literals
 * — `\`${url}<SPACE>${selector}\`` getting written as
 * `\`${url}<NUL>${selector}\``. The bug is invisible in normal diff views,
 * ships green through `tsc`, and only surfaces when the affected runtime
 * string is compared against a literal that has the intended space — and
 * even then the test failure renders the NUL as `<SPACE>`, easy to miss.
 * We hit this 4× in chaosbringer history before adding this check
 * (heatmap.ts, then 3× in coverage.ts on a single PR).
 *
 * Usage: `node scripts/check-no-nul.mjs <dir> [<dir> ...]`. Walks the given
 * directories and reports any *.ts / *.mts / *.cts / *.tsx / *.js / *.mjs /
 * *.cjs / *.jsx / *.json / *.md / *.yml / *.yaml files that contain a NUL
 * byte. Exits 0 when the tree is clean, 1 (with file:line:col + context)
 * otherwise.
 *
 * The script itself never embeds a literal NUL byte: it uses
 * `String.fromCharCode(0)` so the lint cannot trip on its own source.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const NUL = String.fromCharCode(0);
const NUL_PLACEHOLDER = "<NUL>";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
  ".md",
  ".yml",
  ".yaml",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "_build", ".moon", ".flaker"]);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(path)));
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (!SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
      out.push(path);
    }
  }
  return out;
}

function findNulOffsets(buf) {
  const offsets = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf.charCodeAt(i) === 0) offsets.push(i);
  }
  return offsets;
}

function lineAndColumn(buf, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (buf.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("usage: check-no-nul.mjs <dir> [<dir> ...]");
    process.exit(2);
  }

  let bad = 0;
  for (const root of roots) {
    const isDir = await stat(root)
      .then((s) => s.isDirectory())
      .catch(() => false);
    const files = isDir ? await walk(root) : [root];
    for (const file of files) {
      const buf = await readFile(file, "utf8");
      const offsets = findNulOffsets(buf);
      if (offsets.length === 0) continue;
      bad++;
      for (const offset of offsets) {
        const { line, col } = lineAndColumn(buf, offset);
        const lineStart = buf.lastIndexOf("\n", offset - 1) + 1;
        const lineEnd = buf.indexOf("\n", offset);
        const rawLine = buf.slice(lineStart, lineEnd === -1 ? buf.length : lineEnd);
        const content = rawLine.split(NUL).join(NUL_PLACEHOLDER);
        console.error(`${file}:${line}:${col}: NUL byte`);
        console.error(`  | ${content}`);
      }
    }
  }

  if (bad > 0) {
    console.error("");
    console.error(
      `Found NUL bytes in ${bad} file(s). Likely an editor / agent template-literal write bug — replace ${NUL_PLACEHOLDER} with the intended character (often a regular space).`,
    );
    process.exit(1);
  }
}

await main();
