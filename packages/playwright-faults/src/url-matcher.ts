import type { UrlMatcher } from "./types.js";

/**
 * Flags that make a RegExp stateful, and therefore unusable as a matcher.
 *
 * `g` and `y` give a regex a `lastIndex` that `test()` both reads and writes.
 * A fault rule tests one long-lived pattern against every request that goes
 * past, so a `/g` pattern does not mean "match globally" here — it means
 * "match, then start the next request's search after the end of the previous
 * match", which fires on alternating requests and stops firing entirely once
 * `lastIndex` runs past the end of a shorter URL. The user who wrote
 * `/\/api\/save/g` meant the same thing as without the flag; the difference is
 * invisible at the call site and shows up as a fault that fires half the time.
 *
 * Every other flag is a matching question and is honoured: `i`, `m`, `s`, `u`,
 * `v`, `d`.
 */
const STATEFUL_FLAGS = /[gy]/g;

/**
 * Normalise a `UrlMatcher` into a RegExp that can be tested repeatedly.
 *
 * Strings compile with `new RegExp`. RegExps are returned as-is unless they
 * carry a stateful flag, in which case an equivalent stateless copy is
 * returned — the original is left untouched, since it belongs to the caller
 * and may be in use elsewhere.
 */
export function compileUrlMatcher(matcher: UrlMatcher): RegExp {
  if (!(matcher instanceof RegExp)) return new RegExp(matcher);
  const flags = stripStatefulFlags(matcher.flags);
  return flags === matcher.flags ? matcher : new RegExp(matcher.source, flags);
}

/** The flag string a matcher should be tested with. Exported for serialization. */
export function stripStatefulFlags(flags: string): string {
  return flags.replace(STATEFUL_FLAGS, "");
}
