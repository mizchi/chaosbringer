import type { Rule, RuleStats, Snapshot } from "./types.ts";

export interface KumoChaosOptions {
  /** kumo base URL. Defaults to KUMO_ENDPOINT env or http://localhost:4566. */
  endpoint?: string;
  /** AbortSignal forwarded to every fetch. */
  signal?: AbortSignal;
  /** Optional fetch override (mostly for tests). */
  fetch?: typeof fetch;
}

export class KumoChaosError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`kumo chaos API returned ${status}: ${body}`);
    this.name = "KumoChaosError";
  }
}

export interface KumoChaos {
  upsertRule(rule: Rule): Promise<void>;
  deleteRule(id: string): Promise<void>;
  clearRules(): Promise<void>;
  listRules(): Promise<Snapshot>;
  stats(): Promise<RuleStats[]>;
  /** Apply rules atomically — clears all, then installs the new batch. */
  installProfile(rules: Rule[]): Promise<void>;
}

export function kumoChaos(opts: KumoChaosOptions = {}): KumoChaos {
  const base = (opts.endpoint ?? process.env.KUMO_ENDPOINT ?? "http://localhost:4566").replace(/\/$/, "");
  const f = opts.fetch ?? fetch;

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new KumoChaosError(res.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    async upsertRule(rule) {
      await req("POST", "/kumo/chaos/rules", rule);
    },
    async deleteRule(id) {
      await req("DELETE", `/kumo/chaos/rules/${encodeURIComponent(id)}`);
    },
    async clearRules() {
      await req("DELETE", "/kumo/chaos/rules");
    },
    async listRules() {
      return req<Snapshot>("GET", "/kumo/chaos/rules");
    },
    async stats() {
      return req<RuleStats[]>("GET", "/kumo/chaos/stats");
    },
    async installProfile(rules) {
      await req("DELETE", "/kumo/chaos/rules");
      // Sequential, not parallel: kumo's mutex is fine with concurrent writes
      // but failures here are easier to reason about in order.
      for (const r of rules) {
        await req("POST", "/kumo/chaos/rules", r);
      }
    },
  };
}
