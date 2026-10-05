/**
 * What went wrong on a page while something drove it: the crawl's error
 * checks, for runners that are not the crawler (`drive`, its chaos replay).
 *
 * Uncaught exceptions, unhandled rejections (`rejections.ts`), console
 * errors, failed requests (not the ones cancelled in flight by navigating
 * on) and 5xx answers, plus a 4xx on the main frame's own document. Each is
 * stamped with the step that was running.
 */

import type { Page } from "playwright";
import { watchUnhandledRejections } from "../rejections.js";
import { environmentCause } from "../scan/analyze.js";

export interface DriveProblem {
  kind: "exception" | "unhandled-rejection" | "console" | "network" | "http";
  message: string;
  url: string;
  /** The step that caused it; -1 for the initial load. */
  step: number;
  /**
   * Set when the scanning machine caused it, not the site: a proxy that
   * refused the host, a request cancelled by navigating on, media Playwright's
   * Chromium cannot decode (the scan's `ENVIRONMENT_CAUSES`). Kept, for the
   * record, but not a problem with the site.
   */
  environment?: string;
}

/** The problems that are the site's: `environment` ones left out. */
export function siteProblems(problems: readonly DriveProblem[]): DriveProblem[] {
  return problems.filter((p) => p.environment === undefined);
}

export interface ProblemWatch {
  /** Everything seen so far, in order. */
  readonly problems: DriveProblem[];
  /** Stamp what is seen from now on with `step`. */
  setStep(step: number): void;
  /** Collect the rejections the page captured since the last drain. */
  drain(): Promise<void>;
}

export async function watchProblems(page: Page): Promise<ProblemWatch> {
  const problems: DriveProblem[] = [];
  let step = -1;
  const add = (kind: DriveProblem["kind"], message: string, url = safeUrl(page)) => {
    const cause = environmentCause(message);
    problems.push({ kind, message, url, step, ...(cause ? { environment: cause.reason } : {}) });
  };
  page.on("pageerror", (e) => add("exception", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") add("console", m.text());
  });
  page.on("requestfailed", (r) => {
    const failure = r.failure()?.errorText ?? "failed";
    // Cancelled in flight: navigating on cancels beacons and prefetches.
    if (failure === "net::ERR_ABORTED") return;
    add("network", `${r.url()} - ${failure}`);
  });
  page.on("response", (r) => {
    const s = r.status();
    if (s >= 500 || (s >= 400 && r.request().isNavigationRequest() && r.frame() === page.mainFrame())) {
      add("http", `${r.request().method()} ${r.url()} -> ${s}`);
    }
  });
  const rejections = await watchUnhandledRejections(page);
  return {
    problems,
    setStep: (n) => {
      step = n;
    },
    drain: async () => {
      for (const r of await rejections.drain()) add("unhandled-rejection", r.message, r.url ?? safeUrl(page));
    },
  };
}

export function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}
