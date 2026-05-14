/**
 * `authAttackDriver` — composes into a `compositeDriver` chain. When
 * the current page contains an auth form (login or signup) and we
 * haven't already attacked that URL, returns a single `custom` Pick
 * that runs every enabled attack in sequence. Findings are emitted
 * via `onFinding` and (≥ `errorAtSeverity`) re-published as page
 * errors so they land in `report.errorClusters`.
 *
 * Returns `null` on non-auth pages — defer to the next driver.
 */
import type { ActionResult } from "../../types.js";
import type { Driver, DriverPick, DriverStep } from "../types.js";
import { detectAuthForm } from "./detect.js";
import { runAttack, type AttackContext } from "./attacks.js";
import type {
  AuthAttackName,
  AuthAttackOptions,
  AuthFinding,
  AuthFindingSeverity,
} from "./types.js";

const ALL_ATTACKS: ReadonlyArray<AuthAttackName> = [
  "weak-password-signup",
  "username-enumeration",
  "sqli-credentials",
  "xss-credentials",
  "rate-limit-login",
  // Issue #93 — extended OWASP coverage
  "csrf-state-change",
  "session-fixation",
  "password-reset-token-entropy",
];

const SEVERITY_ORDER: Record<AuthFindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface AuthAttackDriver extends Driver {
  /** All findings emitted across the driver's lifetime. */
  getFindings(): AuthFinding[];
}

export function authAttackDriver(opts: AuthAttackOptions = {}): AuthAttackDriver {
  const attackList: ReadonlyArray<AuthAttackName> = opts.attacks ?? ALL_ATTACKS;
  const errorAt = SEVERITY_ORDER[opts.errorAtSeverity ?? "medium"];
  const maxAttacksPerUrl = opts.maxAttacksPerUrl ?? 1;
  const attackCounts = new Map<string, number>();
  const findings: AuthFinding[] = [];
  const log = opts.verbose ? (m: string) => console.log(`[authAttack] ${m}`) : () => {};

  const credentials = opts.testCredentials ?? {
    username: "chaosbringer-test@example.invalid",
    password: "ChaosTest!2024",
  };

  return {
    name: "auth-attack",
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      const url = step.url;
      const seen = attackCounts.get(url) ?? 0;
      if (seen >= maxAttacksPerUrl) return null;

      const detector = opts.detectForm ?? detectAuthForm;
      const form = await detector(step.page).catch(() => null);
      if (!form) return null;
      log(`detected ${form.type} form at ${url}`);
      attackCounts.set(url, seen + 1);

      return {
        kind: "custom",
        source: "auth-attack",
        reasoning: `running ${attackList.length} attack(s) against ${form.type} form`,
        perform: async (page): Promise<ActionResult> => {
          const ctx: AttackContext = {
            page,
            startUrl: url,
            testCredentials: credentials,
            verbose: opts.verbose ?? false,
          };
          // Re-detect — the page may have re-navigated between
          // selectAction (where we detected) and perform (where we
          // attack). Form Locator handles should survive but let's
          // not bet on it across composite drivers.
          const freshForm = await (opts.detectForm ?? detectAuthForm)(page);
          if (!freshForm) {
            return {
              type: "click",
              success: false,
              timestamp: Date.now(),
              error: "auth-attack: form vanished between detect and perform",
            };
          }
          let critical = 0;
          for (const attack of attackList) {
            log(`running ${attack}`);
            const produced = await runAttack(attack, freshForm, ctx).catch((err) => {
              log(`${attack} threw: ${(err as Error).message}`);
              return [] as AuthFinding[];
            });
            for (const f of produced) {
              findings.push(f);
              await opts.onFinding?.(f);
              if (SEVERITY_ORDER[f.severity] >= errorAt) critical += 1;
              log(`finding ${f.severity}: ${f.attack} — ${f.description}`);
            }
          }
          return {
            type: "click",
            success: critical === 0,
            target: `auth-attack::${freshForm.type}`,
            selector: `__auth-attack__::${freshForm.type}`,
            timestamp: Date.now(),
            error: critical > 0
              ? `auth-attack: ${critical} finding(s) at severity >= ${opts.errorAtSeverity ?? "medium"}`
              : undefined,
          };
        },
      };
    },
    getFindings(): AuthFinding[] {
      return [...findings];
    },
  };
}
