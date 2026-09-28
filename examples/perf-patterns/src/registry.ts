/**
 * Every pattern in `src/patterns/`, discovered at runtime: each `*.ts` file
 * there default-exports a `Pattern` whose `id` is its file name. Adding a
 * pattern is adding one file.
 *
 * `PATTERN=<id>[,<id>...]` narrows the list (for the test and the report).
 * `PATTERN_SHARD=<i>/<n>` splits it across CI jobs (see {@link shardPatterns}).
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pattern } from "./pattern.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "patterns");

export async function loadPatterns(filter = process.env.PATTERN): Promise<Pattern[]> {
  const wanted = filter ? new Set(filter.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_"))
    .sort();
  const patterns: Pattern[] = [];
  for (const file of files) {
    const id = file.slice(0, -3);
    if (wanted && !wanted.has(id)) continue;
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: Pattern };
    const pattern = mod.default;
    if (!pattern || typeof pattern.routes !== "function") {
      throw new Error(`src/patterns/${file} must default-export a Pattern (use definePattern)`);
    }
    if (pattern.id !== id) {
      throw new Error(`src/patterns/${file}: pattern id "${pattern.id}" must equal the file name "${id}"`);
    }
    patterns.push(pattern);
  }
  if (wanted) {
    const missing = [...wanted].filter((id) => !patterns.some((p) => p.id === id));
    if (missing.length) throw new Error(`PATTERN names unknown pattern(s): ${missing.join(", ")}`);
  }
  return patterns;
}

/**
 * The `index`-th of `count` shards of `patterns` (1-based, `"2/3"`), dealt
 * round-robin over the sorted list so every shard gets a similar mix. An
 * empty or missing spec is the whole list. Every pattern lands in exactly one
 * shard, so the shards of one `count` together run the full catalog. The spec
 * is a required argument, not an env default, so a caller never shards by
 * accident (the test suite reads `PATTERN_SHARD` itself).
 */
export function shardPatterns<T>(patterns: readonly T[], spec: string | undefined): T[] {
  if (!spec?.trim()) return [...patterns];
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(spec);
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!(count >= 1 && index >= 1 && index <= count)) {
    throw new Error(`PATTERN_SHARD must be <index>/<count> with 1 <= index <= count, got "${spec}"`);
  }
  return patterns.filter((_, i) => i % count === index - 1);
}
