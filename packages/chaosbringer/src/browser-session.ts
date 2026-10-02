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
    const page = await context.newPage();
    return { context, page, close };
  } catch (err) {
    await close();
    throw err;
  }
}
