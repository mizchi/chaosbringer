/**
 * Group similar PageError entries into clusters so a run with 100 identical
 * `console.error("Failed to load X")` calls becomes one cluster with count=100
 * instead of 100 lines.
 *
 * A "fingerprint" normalises the message — strips URLs, numbers, and stack
 * locations — so that `HTTP 500 on /api/users/42` and `HTTP 500 on /api/users/99`
 * collapse to the same cluster but don't swallow unrelated errors.
 */
import type { PageError } from "./types.js";
export interface ErrorCluster {
    /** `<type>|<fingerprint>` — stable across runs. */
    key: string;
    type: PageError["type"];
    fingerprint: string;
    /** A representative error (first one seen). */
    sample: PageError;
    /** Number of errors that collapsed into this cluster. */
    count: number;
    /** Distinct page URLs on which this cluster fired. */
    urls: string[];
    /** Distinct invariant names (only meaningful for type=invariant-violation). */
    invariantNames?: string[];
}
/** Normalise an error message to its fingerprint. */
export declare function fingerprintError(err: PageError): string;
/** Collapse a list of errors into stable clusters. */
export declare function clusterErrors(errors: readonly PageError[]): ErrorCluster[];
//# sourceMappingURL=clusters.d.ts.map