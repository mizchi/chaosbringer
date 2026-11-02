/**
 * Optional peer dependencies, resolved before a browser starts.
 *
 * `axe()` imports axe-core and `visualRegression()` pixelmatch and pngjs
 * inside their checks, so that a project which uses neither never installs
 * them. Without them, `--axe` ran the whole crawl and then failed every page
 * with one "requires the axe-core package" invariant violation and exit 1, as
 * if the site had accessibility bugs; `--visual-baseline` passed its first run
 * (writing baselines needs neither package) and failed every page of the
 * second. A missing package is how the run was set up, not something the site
 * did: `MissingPeerError` refuses the run before it starts, naming the
 * packages and the command that installs them, and the CLI exits 2.
 *
 * An invariant says what it needs with `Invariant.peers`, which the crawler
 * reads; it does not guess from the invariant's name.
 */
import { createRequire } from "node:module";
import type { Invariant } from "./types.js";

/** What `axe()` imports. */
export const AXE_PEERS: readonly string[] = ["axe-core"];
/** What `visualRegression()` imports. */
export const VISUAL_REGRESSION_PEERS: readonly string[] = ["pixelmatch", "pngjs"];

/** Packages something needs: `by` is how a message names it (`--axe`, `invariant "a11y-axe"`). */
export interface PeerNeed {
  by: string;
  peers: readonly string[];
}

const requireHere = createRequire(import.meta.url);

/**
 * Whether `name` resolves from chaosbringer's own location, which is where
 * the presets' `import()` looks for it.
 */
export function peerInstalled(name: string): boolean {
  try {
    requireHere.resolve(name);
    return true;
  } catch (err) {
    // A package whose `exports` offers no `require` entry (an ESM-only
    // release) is there; only `require.resolve` cannot pick an entry of it.
    return (err as { code?: unknown } | null)?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
  }
}

/**
 * Thrown before a browser starts when a package an invariant or a flag needs
 * does not resolve. `packages` are the missing ones, `requiredBy` who needs
 * them, `installCommand` what installs them all.
 */
export class MissingPeerError extends Error {
  readonly packages: string[];
  readonly requiredBy: string[];
  readonly installCommand: string;
  constructor(missing: readonly PeerNeed[]) {
    const packages = [...new Set(missing.flatMap((m) => m.peers))];
    const installCommand = `pnpm add -D ${packages.join(" ")}`;
    const which =
      packages.length === 1
        ? "an optional peer dependency that is not installed. Install it"
        : "optional peer dependencies that are not installed. Install them";
    super(
      `chaosbringer: ${missing.map((m) => `${m.by} needs ${andList(m.peers)}`).join(", ")}: ${which} ` +
        `with \`${installCommand}\` (or \`npm install -D ${packages.join(" ")}\`)`,
    );
    this.name = "MissingPeerError";
    this.packages = packages;
    this.requiredBy = missing.map((m) => m.by);
    this.installCommand = installCommand;
  }
}

export function isMissingPeerError(err: unknown): err is MissingPeerError {
  return err instanceof MissingPeerError;
}

/** `a`, `a and b`, `a, b and c`. */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What `invariants` declare in `peers`, one entry per invariant that declares any. */
export function invariantPeerNeeds(invariants: readonly Invariant[] | undefined): PeerNeed[] {
  return (invariants ?? [])
    .filter((inv) => (inv.peers?.length ?? 0) > 0)
    .map((inv) => ({ by: `invariant "${inv.name}"`, peers: [...inv.peers!] }));
}

/**
 * Throw `MissingPeerError` for the needs whose packages do not resolve.
 * `installed` is the resolver, a seam for tests.
 */
export function assertPeers(needs: readonly PeerNeed[], installed: (name: string) => boolean = peerInstalled): void {
  const known = new Map<string, boolean>();
  const isThere = (name: string) => {
    if (!known.has(name)) known.set(name, installed(name));
    return known.get(name)!;
  };
  const missing = needs
    .map((need) => ({ by: need.by, peers: need.peers.filter((name) => !isThere(name)) }))
    .filter((need) => need.peers.length > 0);
  if (missing.length > 0) throw new MissingPeerError(missing);
}
