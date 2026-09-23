/**
 * Defaults the crawler falls back to for every option the caller omits.
 *
 * Kept beside the option type rather than inside the crawler so the two stay
 * readable together: the `Omit<>` list below is the contract for "opt-in with
 * no meaningful default", and it only means anything next to `CrawlerOptions`.
 */
import type { ActionWeights, CrawlerOptions } from "./types.js";

// Options that are opt-in with no meaningful default (HAR, storage state,
// perf budget, trace, device/network) are carved out of the Required<>
// type instead of inventing sentinels.
export const DEFAULT_OPTIONS: Required<
  Omit<
    CrawlerOptions,
    | "baseUrl"
    | "launchOptions"
    | "cdpEndpoint"
    | "cdpTargetId"
    | "terminalBrowser"
    | "har"
    | "storageState"
    | "performanceBudget"
    | "traceOut"
    | "traceReplay"
    | "device"
    | "network"
    | "seedFromSitemap"
    | "shardIndex"
    | "shardCount"
    | "failureArtifacts"
    | "coverageFeedback"
    | "advisor"
    | "traceparent"
    | "server"
    | "driver"
    | "driverGoal"
  >
> = {
  maxPages: 50,
  maxActionsPerPage: 5,
  timeout: 30000,
  headless: true,
  screenshots: false,
  screenshotDir: "./screenshots",
  excludePatterns: [],
  ignoreErrorPatterns: [],
  spaPatterns: [],
  viewport: { width: 1280, height: 720 },
  userAgent: "",
  blockExternalNavigation: true,
  actionWeights: {},
  logFile: "",
  logLevel: "info",
  logToConsole: false,
  enableRecovery: true,
  recoveryHistorySize: 20,
  seed: 0, // Overwritten at construction time if unset
  invariants: [],
  faultInjection: [],
  lifecycleFaults: [],
  runtimeFaults: [],
  iframeFaults: [],
  initScripts: [],
};

export const DEFAULT_ACTION_WEIGHTS: Required<ActionWeights> = {
  navigationLinks: 3,
  buttons: 2,
  inputs: 1,
  ariaInteractive: 2,
  visibleText: 1.5,
  scroll: 0.5,
};
