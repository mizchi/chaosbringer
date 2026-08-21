# The async bugs that recur

Before inventing a test for an async defect, check whether it is one of these.
Each is a *contract*, a *seeded bug*, and — the part that is easy to get wrong —
the observable that actually separates them. Runnable versions live in
`examples/model-faults/patterns/` in the chaosbringer repo.

## Two harness patterns you will need first

Both of these are what people actually spend their time on, and neither is
about chaos.

**One app process per scenario.** Calling an app's exported `start()` once per
scenario shares its module-level state, so scenario 2 inherits scenario 1's
writes and a "duplicate write" finding may be two scenarios' writes. Spawn it:

```js
import { spawn } from "node:child_process";

async function startApp({ port, env = {} }) {
  // `--import=tsx` only if your entry point is TypeScript and `tsx` is
  // installed; a plain `["server.js"]` otherwise.
  const proc = spawn(process.execPath, ["--import=tsx", "server.ts"], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {          // wait for it to answer, don't sleep blind
    try {
      await fetch(base + "/", { signal: AbortSignal.timeout(200) });
      return { base, stop: () => new Promise((r) => (proc.on("exit", r), proc.kill())) };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  proc.kill();
  throw new Error(`app did not start on ${port}`);
}
```

Serve a *fixed* variant the same way — an env seam the server reads
(`APP_JS=public/app.fixed.js`), or a `page.route("**/app.js", …)` override — so
the original file stays byte-identical and both directions stay re-runnable.

**Reading server state the app cannot steer.** "Prefer a reader the app does not
parameterise" is easy to say and awkward when the app's own endpoint is scoped
by a session the page chose. Take the correlation key off the wire instead of
out of the page:

```js
let sessionKey;
page.on("request", (req) => {
  const k = req.headers()["x-session"];
  if (k !== undefined) sessionKey = k;      // what the browser actually sent
});
// …click…
const { notes } = await fetch(`${base}/api/notes/count?session=${sessionKey}`)
  .then((r) => r.json());                   // plain fetch: not routable, so your
                                            // own rules cannot fault the oracle
```

The two halves matter separately: reading the key from the request means the app
cannot lie about which bucket to count, and reading the count from the test
process means a catch-all fault rule cannot intercept your own reader.

## Retry that writes twice

**Contract:** one user intent produces one write, however many times the client
retries.

The dangerous case is not "the request failed" — it is "the request succeeded
and the client could not tell": the server committed, the response never got
back, the client retried. Whether that is one order or two is decided by whether
the retry carries the same idempotency key.

**Invisible in the UI.** Same "Order placed" banner either way; only the server's
count differs. Needs a state assertion, and the write's scoping key must not be
something the client can re-mint between attempts.

## Refresh stampede

**Contract:** concurrent 401s share one in-flight refresh.

One refresh per 401 hammers the endpoint you least want to overload, and on a
rotating refresh token the second invalidates the first and logs the user out.
Also model the rung where the *refresh itself* fails — that is where a retry
loop against a failing auth endpoint lives, and a model whose refresh always
succeeds cannot express it.

## Timeout ladder

**Contract:** slow and never are different failures. The first must still
render; the second must give up.

An unbounded app handles the slow case perfectly, which is why the missing bound
survives review — and spins forever on the other. Watch for a `Promise.race`
"bound": it bounds the *banner*, cancels nothing, and the abandoned response
still arrives and still costs the server its work.

## Optimistic UI without reconciliation

**Contract:** in any terminal state, the screen shows what the server has.

"Roll back on error" is the wrong rule: a request that never arrived and a reply
that could not be read need *opposite* corrections, and only asking the server
tells them apart. An app that keeps the row without asking is right half the
time and has verified nothing — so the assertion is the reconcile *effect* (row
identity against server ids), not merely that a request went out.

## Out-of-order responses

**Contract:** the newest request's response is the one on screen.

Two keystrokes, two requests, no ordering guarantee. An app that renders on
arrival shows the right number of rows, under the right label, with no error
anywhere — in the wrong order. No per-plan expectation can see this: prompt and
slow predict identical oracles. It needs a DOM consistency check, and it needs
the app to expose the correlation (a `data-` attribute derived from the
response, not from the render position).

## Reconnect with no budget

**Contract:** at most N attempts, then say so.

Retrying a dropped stream is not the question; what the client does when the
retry also fails is, because every client in the fleet is doing it at once
against the service that is already failing. One tab reconnecting forever looks
exactly like one tab being patient — the contract is a *number of requests*, and
nothing on screen carries it.

## Stale-while-revalidate

**Contract:** serving the cached copy is the feature; ending there is the bug.

The request goes out, the response comes back, the JSON parses, and nothing
consumes it. Every error path a reviewer thinks to try behaves perfectly,
because the bug is on the success path. Separate *what the app received* from
*what it rendered* — one variable cannot express it.

## Form double-submit

**Contract:** one intent, one write; the control is disabled while in flight.

The cheapest of these to test and the easiest to forget: a count of one, plus a
DOM assertion that the button was disabled.
