/**
 * Small helper functions that build FaultRule objects without the
 * discriminated-union ceremony. Exported from the package root.
 *
 *   import { faults } from "chaosbringer";
 *   const rules = [
 *     faults.status(500, { urlPattern: /\/api\// }),
 *     faults.abort({ urlPattern: /tracking/ }),
 *     faults.delay(2000, { urlPattern: /\/api\// }),
 *   ];
 */
import type { FaultRule, UrlMatcher } from "./types.js";
export interface FaultHelperOptions {
    urlPattern: UrlMatcher;
    methods?: string[];
    probability?: number;
    name?: string;
}
export declare const faults: {
    /** Respond with `status` (and optional body / content-type). */
    status(status: number, opts: FaultHelperOptions & {
        body?: string;
        contentType?: string;
    }): FaultRule;
    /** Abort the request (e.g. to simulate a blocked third-party or transport failure). */
    abort(opts: FaultHelperOptions & {
        errorCode?: string;
    }): FaultRule;
    /** Wait `ms` milliseconds, then continue the request unchanged. */
    delay(ms: number, opts: FaultHelperOptions): FaultRule;
};
//# sourceMappingURL=faults.d.ts.map