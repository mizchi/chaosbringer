/**
 * Shape of `env` injected by the Cloudflare runtime. Everything is a
 * string because Wrangler vars are stringified — handlers parse to
 * Number where needed.
 */

export interface Env {
  DEPLOY_ENV: string;
  CHAOS_5XX_RATE?: string;
  CHAOS_LATENCY_RATE?: string;
  CHAOS_LATENCY_MS?: string;
  CHAOS_SEED?: string;
}
