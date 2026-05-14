/**
 * Filesystem-backed recipe store. One JSON file per recipe, atomic
 * rename on write. Two-tier lookup (local before global) lets a
 * project override a global recipe by name without touching it.
 *
 * Why per-file rather than one combined `recipes.json`:
 * - Concurrent runs (parallel CI shards) can each update different
 *   recipes' stats without locking the whole file.
 * - `git diff` on a single recipe's promotion is readable; on a giant
 *   blob it isn't.
 * - Hand-editing a single recipe doesn't risk corrupting siblings.
 *
 * The store does NOT enforce schema migration. If a recipe file on
 * disk is malformed, `load()` skips it with a console warning rather
 * than throwing — a corrupt recipe must not block an entire run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionRecipe, RecipeStats } from "./types.js";
import { emptyStats } from "./types.js";

export interface RecipeStoreOptions {
  /** Project-local recipe dir. Default: `./chaosbringer-recipes`. Set to `false` to disable. */
  localDir?: string | false;
  /** Cross-project recipe dir. Default: `$XDG_DATA_HOME/chaosbringer/recipes` or `~/.chaosbringer/recipes`. Set to `false` to disable. */
  globalDir?: string | false;
  /**
   * Promotion threshold: a candidate becomes verified once it has
   * ≥ `minRuns` total recorded runs AND a success ratio ≥ `minSuccessRate`.
   */
  minRuns?: number;
  minSuccessRate?: number;
  /**
   * Demotion threshold: a verified recipe drops back to candidate once
   * its recent failure rate (computed across the last `minRuns` runs)
   * exceeds `1 - minSuccessRate`. Conservative — we'd rather keep using
   * a slightly flaky recipe than blow away accumulated stats.
   */
  silent?: boolean;
}

const DEFAULT_MIN_RUNS = 5;
const DEFAULT_MIN_SUCCESS_RATE = 0.8;

function defaultGlobalDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "chaosbringer", "recipes");
  return join(homedir(), ".chaosbringer", "recipes");
}

/**
 * Sanitise a recipe name into a safe filename. We keep alphanumerics,
 * `-`, `_`, and `.`, and replace `/` with `__` so namespacing like
 * `shop/checkout` survives. Anything else collapses to `_` to keep the
 * filesystem happy across platforms.
 */
export function recipeFilename(name: string): string {
  const sanitised = name.replace(/\//g, "__").replace(/[^A-Za-z0-9_.\-]/g, "_");
  return `${sanitised}.json`;
}

export class RecipeStore {
  private readonly local: string | null;
  private readonly global: string | null;
  private readonly minRuns: number;
  private readonly minSuccessRate: number;
  private readonly silent: boolean;
  private cache = new Map<string, ActionRecipe>();
  private loaded = false;

  constructor(opts: RecipeStoreOptions = {}) {
    this.local = opts.localDir === false
      ? null
      : (opts.localDir ?? join(process.cwd(), "chaosbringer-recipes"));
    this.global = opts.globalDir === false
      ? null
      : (opts.globalDir ?? defaultGlobalDir());
    this.minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
    this.minSuccessRate = opts.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE;
    this.silent = opts.silent ?? false;
  }

  /** Load both tiers into the in-memory cache. Local overrides global. */
  load(): void {
    this.cache.clear();
    if (this.global) this.loadFrom(this.global);
    if (this.local) this.loadFrom(this.local);
    this.loaded = true;
  }

  private loadFrom(dir: string): void {
    if (!existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of names) {
      if (!file.endsWith(".json")) continue;
      const full = join(dir, file);
      try {
        const raw = readFileSync(full, "utf8");
        const recipe = JSON.parse(raw) as ActionRecipe;
        if (!recipe.name || !Array.isArray(recipe.steps)) {
          if (!this.silent) console.warn(`recipe-store: skipping malformed ${full}`);
          continue;
        }
        this.cache.set(recipe.name, recipe);
      } catch (err) {
        if (!this.silent) console.warn(`recipe-store: failed to read ${full}: ${(err as Error).message}`);
      }
    }
  }

  /** Returns a deep-copied snapshot — caller mutations don't leak. */
  get(name: string): ActionRecipe | null {
    this.ensureLoaded();
    const recipe = this.cache.get(name);
    return recipe ? deepClone(recipe) : null;
  }

  /** All recipes currently in the store (cloned). Order is unspecified. */
  list(): ActionRecipe[] {
    this.ensureLoaded();
    return [...this.cache.values()].map(deepClone);
  }

  /** Only `verified` recipes — what `recipeDriver` actually replays. */
  verified(): ActionRecipe[] {
    return this.list().filter((r) => r.status === "verified");
  }

  /**
   * Recipes whose first URL precondition matches the given hostname.
   * The match is a substring check on the regex source — e.g.
   * `byDomain("github.com")` matches `urlPattern: "github\\.com\\/.*"`.
   * Recipes with no URL precondition (cross-host) are returned for
   * every domain.
   *
   * Convenience for multi-host crawls: drivers can scope replay to
   * "only github.com recipes when on github.com" without re-scanning
   * the full store on every step.
   */
  byDomain(host: string): ActionRecipe[] {
    const needle = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return this.list().filter((r) => {
      const first = r.preconditions[0]?.urlPattern;
      if (!first) return true; // unscoped recipes
      return first.includes(needle);
    });
  }

  /** Distinct domains across the cached recipes. */
  domains(): string[] {
    const out = new Set<string>();
    for (const r of this.list()) {
      const pattern = r.preconditions[0]?.urlPattern;
      if (!pattern) continue;
      const match = /([A-Za-z0-9][A-Za-z0-9.-]*\\\.[A-Za-z]{2,})/.exec(pattern);
      if (match) out.add(match[1]!.replace(/\\\./g, "."));
    }
    return [...out].sort();
  }

  /**
   * Insert or replace a recipe. New recipes start as `candidate` with
   * empty stats unless explicitly provided. The write target is the
   * local dir if available, otherwise global. Writing to neither is
   * an error (call sites should check `canWrite` first).
   */
  upsert(recipe: ActionRecipe): void {
    this.ensureLoaded();
    const stored: ActionRecipe = {
      ...recipe,
      status: recipe.status ?? "candidate",
      stats: recipe.stats ?? emptyStats(),
      version: recipe.version ?? 1,
      createdAt: recipe.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.cache.set(stored.name, stored);
    this.persist(stored);
  }

  /** Remove from cache + disk. No-op if the recipe doesn't exist. */
  delete(name: string): void {
    this.ensureLoaded();
    if (!this.cache.has(name)) return;
    this.cache.delete(name);
    const filename = recipeFilename(name);
    for (const dir of [this.local, this.global]) {
      if (!dir) continue;
      const path = join(dir, filename);
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // best-effort
        }
      }
    }
  }

  recordSuccess(name: string, durationMs: number): void {
    const r = this.cache.get(name);
    if (!r) return;
    const stats = { ...r.stats };
    const prevSuccess = stats.successCount;
    stats.successCount = prevSuccess + 1;
    // Rolling mean across successful runs only.
    stats.avgDurationMs = prevSuccess === 0
      ? durationMs
      : (stats.avgDurationMs * prevSuccess + durationMs) / (prevSuccess + 1);
    stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);
    stats.lastSuccessAt = Date.now();
    const updated: ActionRecipe = {
      ...r,
      stats,
      status: this.computeStatus(r.status, stats),
      updatedAt: Date.now(),
    };
    this.cache.set(name, updated);
    this.persist(updated);
  }

  recordFailure(name: string): void {
    const r = this.cache.get(name);
    if (!r) return;
    const stats = { ...r.stats, failCount: r.stats.failCount + 1, lastFailAt: Date.now() };
    const updated: ActionRecipe = {
      ...r,
      stats,
      status: this.computeStatus(r.status, stats),
      updatedAt: Date.now(),
    };
    this.cache.set(name, updated);
    this.persist(updated);
  }

  /** Direct status override — used by `verifyAndPromote` after a batch run. */
  setStatus(name: string, status: ActionRecipe["status"]): void {
    const r = this.cache.get(name);
    if (!r) return;
    const updated: ActionRecipe = { ...r, status, updatedAt: Date.now() };
    this.cache.set(name, updated);
    this.persist(updated);
  }

  private computeStatus(prev: ActionRecipe["status"], stats: RecipeStats): ActionRecipe["status"] {
    const total = stats.successCount + stats.failCount;
    if (total < this.minRuns) return prev;
    const rate = stats.successCount / total;
    if (rate >= this.minSuccessRate) return "verified";
    // Don't auto-demote across the threshold — that ping-pongs noisily
    // when rate hovers near the boundary. Demotion is left to explicit
    // `setStatus` calls (verifier's job).
    if (prev === "verified" && rate < 0.5) return "demoted";
    return prev === "verified" ? "verified" : "candidate";
  }

  private persist(recipe: ActionRecipe): void {
    const dir = this.local ?? this.global;
    if (!dir) {
      if (!this.silent) console.warn("recipe-store: no writable directory configured");
      return;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filename = recipeFilename(recipe.name);
    const path = join(dir, filename);
    // Atomic rename to avoid half-written files when a sibling process
    // is reading.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(recipe, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
