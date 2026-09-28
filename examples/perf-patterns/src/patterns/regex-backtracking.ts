import { definePattern, html, page, type Variant } from "../pattern.js";

// A sign-up form checks the user name part of an email address before it
// submits. The user pasted a long name with a stray character at the end, so
// the check must fail. Both patterns accept the same language (runs of
// letters and digits, each followed by at most one ".", "_" or "-"); they
// differ in how the regex engine gets to "no".
//
// The slow pattern nests quantifiers: ([a-z0-9]+[._-]?)+. The separator is
// optional, so a run of N letters can be split between the inner and outer
// "+" in 2^(N-1) ways, and on a string that fails at its last character the
// backtracking engine (V8's Irregexp, like PCRE, Java and .NET) tries every
// split before giving up. The fixed pattern makes each split unique, a run,
// then (separator, run)*, then an optional trailing separator, so a failure
// is found in one pass.
//
// The work doubles with each extra letter, so NAME_LENGTH sets it (a slower
// machine does the same steps in more time, never fewer). V8 runs a regex's
// first executions in its bytecode interpreter and compiles it to machine
// code once it is hot, so the first check on a page is several times slower
// than the next: at 24 letters ~850 ms, then ~135 ms. The crawl clicks once
// per page, so every value is a first check.
const NAME_LENGTH = 24;
const INPUT = `${"a".repeat(NAME_LENGTH)}!`;

const patterns: Record<Variant, string> = {
  slow: String.raw`/^([a-z0-9]+[._-]?)+$/i`,
  fixed: String.raw`/^[a-z0-9]+(?:[._-][a-z0-9]+)*[._-]?$/i`,
};

export default definePattern({
  id: "regex-backtracking",
  title: "Catastrophic regex backtracking on validation",
  category: "main-thread",
  description: `Clicking "Check address" freezes the page for most of a second on a ${NAME_LENGTH + 1}-character input. The validation regex nests quantifiers, ([a-z0-9]+[._-]?)+, so a string that fails at its last character makes the backtracking engine try every way to split the letters between the inner and the outer "+": 2^${NAME_LENGTH - 1} of them, doubling with each extra character (a ReDoS).`,
  fix: "Write the regex so each input has one way to match: no quantified group whose body can match the same text in several ways (a run, then (separator, run)*); cap the input's length before matching, and lint regexes for nested quantifiers (eslint-plugin-regexp, safe-regex).",
  routes: (variant) => ({
    "/": html(
      page(
        "Sign up",
        `<h1>Sign up</h1>
<input id="email" aria-label="Email" value="${INPUT}@example.com" size="50">
<button id="check" type="button">Check address</button>
<p id="out"></p>
<script>
    const USER = ${patterns[variant]};
    document.getElementById("check").addEventListener("click", () => {
      const [user] = document.getElementById("email").value.split("@");
      document.getElementById("out").textContent = USER.test(user) ? "Looks good" : "Invalid user name";
    });
</script>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    // One check per page visit: a second one would run the compiled regex
    // (see above), and pooling the two kinds of value blurs the median.
    maxActionsPerPage: 1,
    seed: 1,
    // Only the button: a fill would replace the pasted value.
    actionWeights: { scroll: 0, inputs: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "cpu.blockingMs",
    direction: "lower",
    // slow: one ~850 ms task on the first check (~135 ms compiled, if V8
    // ever compiles it up front); fixed: a linear scan, 0.
    minImprovement: { ratio: 5, absolute: 50 },
  },
});
