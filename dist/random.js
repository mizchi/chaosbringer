/**
 * Deterministic pseudo-random number generator.
 *
 * Uses mulberry32 — small, fast, 32-bit state, good enough for test
 * action selection. Same seed → same sequence, so chaos runs are
 * reproducible.
 */
export function createRng(seed) {
    let state = seed >>> 0;
    return {
        seed,
        next() {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
    };
}
/** Generate a random 32-bit seed from Math.random (for when the user didn't pass one). */
export function randomSeed() {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}
/** Pick one item from `items` using weights (sum > 0 required). */
export function weightedPick(items, weightOf, rng) {
    if (items.length === 0) {
        throw new Error("weightedPick: items is empty");
    }
    let total = 0;
    for (const item of items)
        total += weightOf(item);
    if (total <= 0)
        return items[items.length - 1];
    let roll = rng.next() * total;
    for (const item of items) {
        roll -= weightOf(item);
        if (roll <= 0)
            return item;
    }
    return items[items.length - 1];
}
/** Integer in [0, max). */
export function randomInt(rng, max) {
    return Math.floor(rng.next() * max);
}
