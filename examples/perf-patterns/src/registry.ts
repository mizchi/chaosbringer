/**
 * Every pattern in `src/patterns/`, discovered at runtime: each `*.ts` file
 * there default-exports a `Pattern` whose `id` is its file name. Adding a
 * pattern is adding one file.
 *
 * `PATTERN=<id>[,<id>...]` narrows the list (for the test and the report).
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
