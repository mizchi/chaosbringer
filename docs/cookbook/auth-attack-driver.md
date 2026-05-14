# Attack login / signup forms (OWASP-aligned)

`authAttackDriver` is a Driver that detects login and signup forms on
the current page and runs a small set of OWASP-aligned attack
scenarios against them. Findings come out as structured objects you
can pipe into reports, gate CI on, or feed to `investigate()` for
deeper diagnosis.

> **Authorisation reminder.** This driver fires SQLi / XSS payloads,
> submits weak passwords, and bursts login attempts. **Only run it
> against applications you are authorised to test** — typically your
> own dev or staging environment. The chaos crawler's external-URL
> guard prevents accidental traffic to third-party hosts, but you
> own the responsibility for the targets you configure.

## The five built-in attacks

| Attack | Form | OWASP / NIST | What it confirms |
|---|---|---|---|
| `weak-password-signup` | signup | NIST 800-63B §5.1.1.2 / ASVS V2.1.7 | Signup accepts a known-bad password (`password`, `12345678`, …) without warning. |
| `username-enumeration` | login | ASVS V2.2.1 / WSTG-IDNT-04 | Error messages differ for valid-shaped vs definitely-invalid usernames. |
| `sqli-credentials` | login | A03:2021 Injection / WSTG-INPV-05 | An auth-bypass SQLi payload (`' OR '1'='1`) succeeds *or* elicits a database error in the response. |
| `xss-credentials` | login + signup | A03:2021 Injection / WSTG-INPV-01 | A submitted payload either fires JS in the response or is reflected verbatim into the rendered HTML. |
| `rate-limit-login` | login | ASVS V2.2.1 / WSTG-ATHN-03 | 8 consecutive failed logins produce neither a 429/423 nor any observable slowdown. |

## Quickstart

```ts
import {
  authAttackDriver,
  chaos,
  compositeDriver,
  weightedRandomDriver,
  type AuthFinding,
} from "chaosbringer";

const findings: AuthFinding[] = [];

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver({
    drivers: [
      authAttackDriver({
        onFinding: (f) => findings.push(f),
        // Optional: an existing test account so username-enumeration
        // has a valid-shaped username to compare against.
        testCredentials: {
          username: "test-user@example.com",
          password: "wrong-password-on-purpose",
        },
      }),
      weightedRandomDriver(),    // navigate the rest of the app
    ],
  }),
  maxPages: 10,
});

for (const f of findings) {
  console.log(`[${f.severity}] ${f.attack}: ${f.description}`);
  console.log(`    ref: ${f.reference}`);
}
```

The driver returns `null` on pages without an auth form, so the
surrounding composite chain handles the rest of the crawl as usual.
When it does fire, the entire attack burst is wrapped in a single
`DriverPick.custom` so it counts as **one** chaos action — your
`maxActionsPerPage` budget doesn't get devoured.

## Finding shape

```ts
interface AuthFinding {
  attack: AuthAttackName;          // 5 built-ins above
  severity: "info" | "low" | "medium" | "high" | "critical";
  url: string;                     // where the form was detected
  formType: "login" | "signup";
  description: string;             // single-line summary
  reference: string;               // OWASP / WSTG / NIST identifier
  evidence?: Record<string, unknown>;
}
```

`info` is the "defence working as intended" signal (e.g. server
returned 429 during the rate-limit burst). `critical` is reserved
for confirmed bypass — SQLi that actually logged in, XSS that
actually executed JS. Default behaviour fires a `pageerror` for
every finding ≥ `medium` so they cluster into
`report.errorClusters` automatically; override with
`errorAtSeverity: "critical"` if you want only confirmed bypasses to
red-light CI.

## Selectively running attacks

Each attack does its own form submission burst — running all five
costs ~25 round-trips per detected page. When iterating on a fix:

```ts
authAttackDriver({
  attacks: ["sqli-credentials"],    // only the one you're testing
  maxAttacksPerUrl: 3,              // re-attack across reloads
});
```

## What the driver does NOT do

- **No DoS / resource exhaustion.** No multi-megabyte inputs, no
  long-running connection holders. If you want input-size testing,
  use `payloadDriver` with `LARGE_PAYLOADS`.
- **No CSRF probes.** CSRF is a server-validation concern that
  needs a separate cross-origin context. Out of scope for a Driver
  that operates inside a single browser tab.
- **No captcha bypass.** Defeating a captcha is explicit attack
  capability, not defensive testing. If your signup has a captcha,
  configure it to accept a known test value (or disable it) in your
  dev environment so the driver can reach the form.
- **No HTTPS / cookie security checks.** Those are network-layer
  concerns. The chaos report's HAR output is the right surface for
  inspecting cookie flags after the fact.
- **No password reset token entropy testing.** Reset flows are out
  of scope here — they typically involve an email step the driver
  can't observe.

## Plugging in to the AI flywheel

Findings make excellent regression candidates for
[`investigate()`](./ai-flywheel.md). After a chaos run that fired a
critical finding, hand the URL to the investigator so the AI
reproduces it with the minimum click sequence:

```ts
import { aiDriver, anthropicDriverProvider, investigate, RecipeStore } from "chaosbringer";

const investigator = aiDriver({
  provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});
const store = new RecipeStore();

for (const f of findings.filter((x) => x.severity === "critical")) {
  await investigate({
    failure: {
      url: f.url,
      signature: `auth-${f.attack}`,
      errorMessages: [f.description, `ref: ${f.reference}`],
      notes: `Auth-attack finding: ${f.attack}`,
    },
    driver: investigator,
    store,
  });
}
```

The resulting `regression/auth-*` recipes go into the same store
your `recipeDriver` already reads, so the bug becomes a permanently
covered case for future load + chaos runs.

## Custom form detection

The default detector finds `input[type=password]` + a sibling
username/email input + a submit button, then classifies login vs
signup using URL hints (`/login`, `/signup`, etc.) and the presence
of a confirm-password input. If your app uses a non-standard
markup pattern (multi-step wizard, web-component-wrapped fields),
override:

```ts
authAttackDriver({
  detectForm: async (page) => {
    if (!page.url().endsWith("/account")) return null;
    return {
      type: "signup",
      form: page.locator("#account-form"),
      usernameField: page.locator("#email"),
      passwordField: page.locator("#pw"),
      confirmPasswordField: page.locator("#pw-confirm"),
      submitButton: page.locator("#submit"),
    };
  },
});
```

## Gotchas

- **`maxAttacksPerUrl` defaults to 1.** The crawler may visit the
  same login page many times — without the cap, every visit would
  burst another 25 submissions. Raise it to 3-5 only if you need
  reproducibility for one specific attack.
- **`testCredentials.username` matters for username enumeration.**
  Supply a credential the app *would treat as a known user* (even
  with a wrong password). The default is a synthetic
  `chaosbringer-test@example.invalid` shape that the app should
  treat as unknown — so by default both probes hit the same "no
  such user" branch and the attack reports no finding. Plug in a
  real test account to get useful coverage.
- **Findings are local to the driver instance.** Use `onFinding` or
  the `getFindings()` accessor — they aren't currently mirrored into
  `report` automatically (besides the `pageerror` surface).
- **The driver is stateful per URL.** If your auth lives behind a
  router that rewrites the URL after each submit, set
  `maxAttacksPerUrl` higher OR override `detectForm` to key off the
  form's hash signature instead of the URL.

## Related

- The driver framework: [`docs/recipes/drivers.md`](../recipes/drivers.md)
- AI ↔ Recipe flywheel for turning findings into regression coverage: [`./ai-flywheel.md`](./ai-flywheel.md)
- Generic payload driver (XSS / SQLi / path traversal across any field): see `payloadDriver` in [`docs/recipes/drivers.md`](../recipes/drivers.md).
