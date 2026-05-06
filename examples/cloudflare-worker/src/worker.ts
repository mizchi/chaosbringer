/**
 * Cloudflare Worker entry. The Hono app + chaos middleware lives in
 * `app.ts` so the chaos config can be swapped without touching the
 * runtime adapter.
 */

import { createApp } from "./app.js";
import type { Env } from "./types.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createApp(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
