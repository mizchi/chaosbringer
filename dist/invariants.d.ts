/**
 * Built-in invariant presets. Mirrors the `faults` helpers — lets users wire
 * common assertions without writing the check() closure each time.
 *
 * Presets declared here are otherwise ordinary Invariants. They just know how
 * to set up their own tooling (e.g. inject axe-core into the page).
 */
import type { Invariant } from "./types.js";
import { visualRegression } from "./visual.js";
export interface AxeInvariantOptions {
    /** Display name for reporting. Default: `a11y-axe`. */
    name?: string;
    /** Restrict to URLs matching this matcher. */
    urlPattern?: Invariant["urlPattern"];
    /** Phase to evaluate. Default: `afterActions`. */
    when?: Invariant["when"];
    /**
     * Axe rule tags to include. Default: WCAG 2 A / AA. Pass fewer for stricter
     * runs (`["wcag2a"]`) or more for exhaustive audits (add `"best-practice"`).
     */
    tags?: string[];
    /** CSS selectors to restrict the scan to. */
    include?: string[];
    /** CSS selectors to skip (e.g. 3rd-party widgets you don't own). */
    exclude?: string[];
    /** Rule ids to disable, e.g. `["color-contrast"]`. */
    disableRules?: string[];
}
/** Shape of the axe-core run result we rely on. Kept minimal. */
interface AxeViolationNode {
    html?: string;
    target?: unknown;
}
interface AxeViolation {
    id: string;
    impact?: string | null;
    help?: string;
    nodes: AxeViolationNode[];
}
/** Shape of what axe.run receives. Pure — returned verbatim into page.evaluate. */
export interface AxeRunPayload {
    context: {
        include?: string[][];
        exclude?: string[][];
    } | null;
    options: {
        runOnly: {
            type: "tag";
            values: string[];
        };
        rules?: Record<string, {
            enabled: false;
        }>;
        resultTypes: ["violations"];
    };
}
export declare function buildAxeRunPayload(opts?: AxeInvariantOptions): AxeRunPayload;
/**
 * Render a violations array to a single-line summary suitable for the
 * invariant failure message. Example:
 *   `3 violations: color-contrast(×5, serious), image-alt(×2, critical)`
 */
export declare function formatAxeViolations(violations: AxeViolation[]): string;
/**
 * Axe-core invariant preset. Injects axe into every page the invariant runs
 * on, calls `axe.run`, and fails with a one-line summary of the violations.
 * Requires `axe-core` to be installed — it's an optional peer dep.
 */
export declare function axe(options?: AxeInvariantOptions): Invariant;
/** Exported as a namespace so consumers can write `invariants.axe(...)`. */
export declare const invariants: {
    axe: typeof axe;
    visualRegression: typeof visualRegression;
};
export {};
//# sourceMappingURL=invariants.d.ts.map