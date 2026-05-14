/**
 * Storage state snapshots for `requires` chain optimisation.
 *
 * When a recipe like `auth/login` is a prerequisite for dozens of
 * dependents, replaying it every iteration is wasted Chromium time.
 * After the first successful replay, we capture
 * `page.context().storageState()` and persist it alongside the recipe;
 * subsequent matches inject the storage state instead of replaying
 * the steps.
 *
 * Invalidation:
 *   - TTL (default 30 min) — snapshots beyond their TTL are ignored
 *     and the runner re-replays the recipe.
 *   - Snapshot version (`SNAPSHOT_FORMAT_VERSION`) — bump if the
 *     on-disk shape changes; older snapshots are silently dropped.
 *
 * The snapshot lives next to the recipe file:
 *   chaosbringer-recipes/auth__login.json          ← recipe
 *   chaosbringer-recipes/auth__login.state.json    ← snapshot (this module)
 *
 * Snapshots are NEVER shipped across hosts. Cross-host reuse needs a
 * different design (per-host snapshot bundles); v1 is intra-host only.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { recipeFilename } from "./store.js";

export const SNAPSHOT_FORMAT_VERSION = 1;

/** Default TTL: 30 minutes. Sessions older than this re-authenticate. */
export const DEFAULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

export interface RecipeSnapshot {
  /** Schema version. Bump on incompatible changes. */
  formatVersion: number;
  /** Recipe name this snapshot was captured from. */
  recipeName: string;
  /** Recipe version at capture time — invalidates on recipe edits. */
  recipeVersion: number;
  /** UTC ms when the snapshot was taken. */
  capturedAt: number;
  /** Browser origin the snapshot was captured against. URLs outside this origin should not consume it. */
  origin: string | null;
  /** Raw Playwright storage state, including cookies + localStorage. */
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
}

export interface CaptureOptions {
  /** Recipe name. */
  name: string;
  recipeVersion: number;
  /** Directory the snapshot is written to. Usually the recipe's local dir. */
  dir: string;
  /** Origin to record on the snapshot (host of the page). */
  origin: string | null;
}

/** Capture a snapshot from the live BrowserContext + write to disk. */
export async function captureSnapshot(
  context: BrowserContext,
  opts: CaptureOptions,
): Promise<RecipeSnapshot> {
  const storageState = await context.storageState();
  const snapshot: RecipeSnapshot = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    recipeName: opts.name,
    recipeVersion: opts.recipeVersion,
    capturedAt: Date.now(),
    origin: opts.origin,
    storageState,
  };
  writeSnapshotAtomic(opts.dir, opts.name, snapshot);
  return snapshot;
}

/**
 * Return the snapshot if present, valid (matching format + recipeVersion),
 * and within `ttlMs`. Otherwise null — caller falls back to running the
 * recipe. Stale / mismatched snapshots are deleted opportunistically.
 */
export function loadSnapshot(
  dir: string,
  name: string,
  opts: {
    recipeVersion: number;
    ttlMs?: number;
  },
): RecipeSnapshot | null {
  const path = snapshotPath(dir, name);
  if (!existsSync(path)) return null;
  let parsed: RecipeSnapshot;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as RecipeSnapshot;
  } catch {
    // Corrupt snapshot — remove so future runs don't re-fail on it.
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
  if (parsed.formatVersion !== SNAPSHOT_FORMAT_VERSION) return discardAndReturnNull(path);
  if (parsed.recipeName !== name) return discardAndReturnNull(path);
  if (parsed.recipeVersion !== opts.recipeVersion) return discardAndReturnNull(path);

  const ttl = opts.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  if (Date.now() - parsed.capturedAt > ttl) return discardAndReturnNull(path);
  return parsed;
}

/**
 * Inject the snapshot's cookies + localStorage into the given context.
 * Returns true if applied, false if the snapshot's origin mismatches
 * the page's current origin (we refuse to cross-contaminate).
 *
 * The caller is responsible for navigating to the recipe's start URL
 * AFTER this returns true so the injected localStorage takes effect.
 */
export async function applySnapshot(
  context: BrowserContext,
  snapshot: RecipeSnapshot,
  options: { currentOrigin?: string | null } = {},
): Promise<boolean> {
  // If a current origin is provided, refuse cross-origin injection.
  // Playwright's addCookies accepts cross-domain cookies silently —
  // we'd rather fail than ship a github.com cookie to attacker.com.
  if (snapshot.origin && options.currentOrigin && snapshot.origin !== options.currentOrigin) {
    return false;
  }
  if (snapshot.storageState.cookies.length > 0) {
    await context.addCookies(snapshot.storageState.cookies);
  }
  if (snapshot.storageState.origins.length > 0) {
    // Restore localStorage + sessionStorage via addInitScript: any
    // page loaded in this context starts with the snapshot's state.
    const origins = snapshot.storageState.origins;
    const script = `(() => {
      const ORIGINS = ${JSON.stringify(origins)};
      try {
        const here = location.origin;
        for (const o of ORIGINS) {
          if (o.origin !== here) continue;
          for (const item of o.localStorage ?? []) {
            try { localStorage.setItem(item.name, item.value); } catch {}
          }
        }
      } catch {}
    })();`;
    await context.addInitScript(script);
  }
  return true;
}

export function deleteSnapshot(dir: string, name: string): void {
  const path = snapshotPath(dir, name);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

export function snapshotPath(dir: string, name: string): string {
  const stem = recipeFilename(name).replace(/\.json$/, "");
  return join(dir, `${stem}.state.json`);
}

function discardAndReturnNull(path: string): null {
  try { unlinkSync(path); } catch { /* ignore */ }
  return null;
}

function writeSnapshotAtomic(dir: string, name: string, snapshot: RecipeSnapshot): void {
  const path = snapshotPath(dir, name);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
