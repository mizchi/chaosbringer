/**
 * Deterministic pseudo-random number generator.
 *
 * Uses mulberry32 — small, fast, 32-bit state, good enough for test
 * action selection. Same seed → same sequence, so chaos runs are
 * reproducible.
 */
export interface Rng {
    /** Returns a float in [0, 1). */
    next(): number;
    /** Returns the seed used to initialise this generator. */
    readonly seed: number;
}
export declare function createRng(seed: number): Rng;
/** Generate a random 32-bit seed from Math.random (for when the user didn't pass one). */
export declare function randomSeed(): number;
/** Pick one item from `items` using weights (sum > 0 required). */
export declare function weightedPick<T>(items: readonly T[], weightOf: (item: T) => number, rng: Rng): T;
/** Integer in [0, max). */
export declare function randomInt(rng: Rng, max: number): number;
//# sourceMappingURL=random.d.ts.map