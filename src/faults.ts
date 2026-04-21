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

function applyCommon(rule: FaultRule, opts: FaultHelperOptions): FaultRule {
  rule.urlPattern = opts.urlPattern;
  if (opts.methods !== undefined) rule.methods = opts.methods;
  if (opts.probability !== undefined) rule.probability = opts.probability;
  if (opts.name !== undefined) rule.name = opts.name;
  return rule;
}

export const faults = {
  /** Respond with `status` (and optional body / content-type). */
  status(
    status: number,
    opts: FaultHelperOptions & { body?: string; contentType?: string }
  ): FaultRule {
    const rule: FaultRule = {
      urlPattern: opts.urlPattern,
      fault: {
        kind: "status",
        status,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      },
    };
    return applyCommon(rule, opts);
  },

  /** Abort the request (e.g. to simulate a blocked third-party or transport failure). */
  abort(opts: FaultHelperOptions & { errorCode?: string }): FaultRule {
    const rule: FaultRule = {
      urlPattern: opts.urlPattern,
      fault: {
        kind: "abort",
        ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
      },
    };
    return applyCommon(rule, opts);
  },

  /** Wait `ms` milliseconds, then continue the request unchanged. */
  delay(ms: number, opts: FaultHelperOptions): FaultRule {
    const rule: FaultRule = {
      urlPattern: opts.urlPattern,
      fault: { kind: "delay", ms },
    };
    return applyCommon(rule, opts);
  },
};
