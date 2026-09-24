// ESM resolver/loader hook (registered by pw-hook.mjs). Redirects a spec's
// `import { test } from "@playwright/test"` to a shim that re-exports the real
// package but overrides `test` with lightbringer's auto-instrumented version
// (autoWrap). The whole existing playwright.config (webServer / baseURL / projects)
// is reused as-is because the CLI just runs `playwright test --config`.
//
// LIGHTBRINGER_AUTO_WRAP = file URL of the installed lightbringer's dist/auto.js.
import path from "node:path";
import { fileURLToPath } from "node:url";

const wrapUrl = process.env.LIGHTBRINGER_AUTO_WRAP || "";
// Never redirect @playwright/test when it's imported BY lightbringer's own dist
// (auto.js needs the REAL base test); only user files (config + specs) are wrapped.
// Excluding the dist dir breaks the otherwise-circular import (shim → auto.js →
// @playwright/test → shim).
const distDir = wrapUrl ? path.dirname(fileURLToPath(wrapUrl)) : "";

export async function resolve(specifier, context, next) {
  if (specifier === "@playwright/test" && wrapUrl) {
    const parent = context.parentURL?.startsWith("file:")
      ? fileURLToPath(context.parentURL)
      : "";
    if (!distDir || !parent || !parent.startsWith(distDir)) {
      const real = await next(specifier, context);
      return { url: "lbshim:" + real.url, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("lbshim:")) {
    const realUrl = url.slice("lbshim:".length);
    // `export *` brings every real export through; the explicit `export const test`
    // shadows the star's `test` with the wrapped one.
    const source =
      `export * from ${JSON.stringify(realUrl)};\n` +
      `import { test as __lbBase } from ${JSON.stringify(realUrl)};\n` +
      `import { autoWrap as __lbWrap } from ${JSON.stringify(wrapUrl)};\n` +
      `export const test = __lbWrap(__lbBase);\n`;
    return { format: "module", source, shortCircuit: true };
  }
  return next(url, context);
}
