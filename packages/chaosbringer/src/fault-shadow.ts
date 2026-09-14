/**
 * Detecting fault rules that can never fire because an earlier rule shadows
 * them — rules are first-match-wins, so a catch-all placed first silently
 * swallows every specific rule after it (issue #129).
 *
 * Best-effort by construction: regex containment is undecidable in general, so
 * this samples a URL from the later pattern and asks whether the earlier one
 * also matches it. False negatives are accepted; false positives are not.
 */
import type { FaultRule } from "./types.js";

/**
 * Strip the regex-metacharacters from `re.source` to produce a candidate
 * URL that the regex would (almost certainly) match. Used by
 * `findFaultRuleShadows` to test whether a later rule is unreachable
 * given an earlier rule's pattern.
 *
 * Best-effort: undecidable in general, but covers the catch-all-shadowing-
 * specific-host case from issue #129.
 */
export function sampleUrlFromRegex(re: RegExp): string {
  let s = re.source;
  // Drop anchors — they're position constraints, not characters.
  s = s.replace(/^\^/, "").replace(/\$$/, "");
  // Drop non-capturing prefixes / lookahead / lookbehind so the literal
  // tail still produces a useful sample.
  s = s.replace(/\(\?[:=!<][^)]*\)/g, "");
  // Drop the rest of unnested groups (`(...)`, `(?...)`, including any
  // trailing quantifier).
  s = s.replace(/\([^()]*\)[?*+]?/g, "");
  // Backslash-escapes for literal characters like `\.` `\/` `\:` `\-`.
  s = s.replace(/\\([./:?&=@#%-])/g, "$1");
  // Common character-class shorthands → a plausible URL-safe letter.
  s = s.replace(/\\[wd]/gi, "a");
  s = s.replace(/\\s/gi, " ");
  // Drop quantified character classes outright (`[^/]+` etc.) — keeping
  // them tends to inject regex syntax into the sample.
  s = s.replace(/\[[^\]]+\][?*+]?/g, "");
  // Drop remaining regex metachars: `*`, `+`, `?`, `|`, `{N}`, `{N,M}`.
  s = s.replace(/\{\d+(,\d*)?\}/g, "");
  s = s.replace(/[*+?|]/g, "");
  return s;
}

/**
 * A later rule is shadowed by an earlier one when every request that would
 * match the later rule also matches the earlier rule. Detection is
 * undecidable for arbitrary regexes — we use `sampleUrlFromRegex` plus the
 * `methods` / `probability` filters to catch the common pathological case
 * called out in #129: catch-all (`/^https?:\/\//`) followed by a specific
 * host (`/^https:\/\/api\.example\.com\//`).
 *
 * Returns one entry per shadowed pair, ordered from outermost loop. False
 * negatives are accepted; false positives should be rare given the strict
 * probability / methods checks.
 */
export function findFaultRuleShadows(
  compiled: ReadonlyArray<{
    rule: FaultRule;
    pattern: RegExp;
    methods?: string[];
  }>,
): Array<{
  earlierIndex: number;
  laterIndex: number;
  earlierName: string;
  laterName: string;
  sampleUrl: string;
}> {
  const out: Array<{
    earlierIndex: number;
    laterIndex: number;
    earlierName: string;
    laterName: string;
    sampleUrl: string;
  }> = [];

  const ruleLabel = (r: FaultRule, pattern: RegExp): string =>
    r.name ?? pattern.toString();

  for (let i = 0; i < compiled.length; i++) {
    const earlier = compiled[i]!;
    // A probability < 1 rule never reliably shadows — some requests fall
    // through to the next rule. Skip to avoid false positives.
    if ((earlier.rule.probability ?? 1) < 1) continue;
    // Same for a schedule that ever passes: only a table of all-"inject"
    // decisions that also keeps injecting past its end covers every
    // occurrence, and therefore shadows what follows.
    const sched = earlier.rule.schedule;
    if (sched && !(sched.afterEnd === "inject" && sched.decisions.every((d) => d === "inject"))) {
      continue;
    }

    for (let j = i + 1; j < compiled.length; j++) {
      const later = compiled[j]!;

      // Method overlap. Earlier must accept every method the later one
      // matches; otherwise some requests escape to `later`.
      if (earlier.methods !== undefined) {
        if (later.methods === undefined) continue; // later: all methods
        const earlierSet = new Set(earlier.methods);
        if (!later.methods.every((m) => earlierSet.has(m))) continue;
      }

      const sample = sampleUrlFromRegex(later.pattern);
      if (sample.length === 0) continue;
      if (!earlier.pattern.test(sample)) continue;

      out.push({
        earlierIndex: i,
        laterIndex: j,
        earlierName: ruleLabel(earlier.rule, earlier.pattern),
        laterName: ruleLabel(later.rule, later.pattern),
        sampleUrl: sample,
      });
    }
  }
  return out;
}
