/**
 * The browser's language: the host's locale as a valid BCP 47 tag. Left
 * unset, Chromium takes it from the process locale, and under POSIX / C
 * (a container, a CI runner) `navigator.language` reads `en-US@posix`. That
 * is not a tag, so a page's `new Intl.Locale(navigator.language)` throws
 * (webscraper.io's did) for a reason no visitor's browser has. Node's Intl
 * has already resolved the host locale to a tag.
 */
export function hostLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}
