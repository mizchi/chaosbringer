#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets from src/ to dist/ after `tsc`.
 *
 * `tsc` only emits .js / .d.ts; anything the compiled code reads from disk
 * at runtime (e.g. the advisor prompt asset) needs to be staged into dist/
 * so the published package and the in-repo runtime both find it.
 *
 * Asset patterns are intentionally kept narrow — adding a glob is fine, but
 * do NOT widen this to "everything except .ts". A loose copier silently
 * ships test fixtures and notes into the published tarball.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
const ASSET_EXTENSIONS = [".md"];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const stats = await stat(full);
    if (stats.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (ASSET_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const assets = await walk(SRC);
let copied = 0;
for (const asset of assets) {
  const rel = relative(SRC, asset);
  const dest = join(DIST, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await readFile(asset));
  copied += 1;
}
console.log(`copy-assets: ${copied} file(s) staged from src/ to dist/`);
