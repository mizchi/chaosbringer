/**
 * Creating the browser contexts and pages the package works in, in one place.
 *
 * Every context starts from `contextOptions()`: a valid locale (see
 * `hostLocale`), with the caller's options on top. Each call site used to
 * write its own `browser.newContext()`, and the ones that forgot the locale
 * (calibrate used `browser.newPage()`) ran with `en-US@posix` on a POSIX host.
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { hostLocale } from "./browser-locale.js";

/** The options every context the package creates starts from, with `options` on top. */
export function contextOptions(options: BrowserContextOptions = {}): BrowserContextOptions {
  return { locale: hostLocale(), ...options };
}

/**
 * Whether this code was compiled with esbuild's `keepNames`, as tsx compiles
 * `src/` (`pnpm crawl`, the tests that spawn `src/cli.ts`). keepNames turns a
 * named function nested in another into `__name(fn, "fn")`, a helper esbuild
 * declares once per module. A function handed to `page.evaluate` or
 * `addInitScript` reaches the page as its source text, where there is no
 * `__name`: it threw, every page reported `__name is not defined`, and the
 * crawl lost the links, action targets and SPA routes those functions find.
 * tsc, which builds dist/, emits no `__name`, so this is false there.
 */
export const COMPILED_WITH_KEEP_NAMES = (() => {
  const probe = () => 0;
  return probe;
}).toString().includes("__name");

/**
 * esbuild's own `__name`, for the page. Writable and configurable, so a page
 * script that declares its own `__name` still can.
 */
const NAME_HELPER_SCRIPT = `if (!("__name" in globalThis)) Object.defineProperty(globalThis, "__name", {
  value: (target, value) => Object.defineProperty(target, "name", { value, configurable: true }),
  writable: true,
  configurable: true,
});`;

/**
 * Gives every document of `target` the `__name` helper when this code was
 * compiled with keepNames, before any init script registered after it runs.
 * A no-op in the published build: its pages get no extra global.
 */
export async function installKeepNamesHelper(target: BrowserContext | Page): Promise<void> {
  if (COMPILED_WITH_KEEP_NAMES) await target.addInitScript({ content: NAME_HELPER_SCRIPT });
}

export interface IsolatedPage {
  context: BrowserContext;
  page: Page;
  /** Closes the context (and with it the page). Never throws. */
  close: () => Promise<void>;
}

/**
 * A page in a context of its own on `browser`. A failure opening the page
 * closes the context it already opened before rethrowing.
 */
export async function newIsolatedPage(browser: Browser, options: BrowserContextOptions = {}): Promise<IsolatedPage> {
  const context = await browser.newContext(contextOptions(options));
  const close = () => context.close().catch(() => {});
  try {
    await installKeepNamesHelper(context);
    const page = await context.newPage();
    return { context, page, close };
  } catch (err) {
    await close();
    throw err;
  }
}
