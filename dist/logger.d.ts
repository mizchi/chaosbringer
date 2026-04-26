/**
 * Logger for Chaos Crawler
 *
 * Writes structured logs to file and/or console during execution.
 */
import type { PageResult, PageError, ActionResult, RecoveryInfo } from "./types.js";
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    event: string;
    data?: Record<string, unknown>;
}
export interface LoggerOptions {
    /** Path to log file (if not set, no file logging) */
    logFile?: string;
    /** Minimum log level to write */
    level?: LogLevel;
    /** Also write to console */
    console?: boolean;
    /** Use JSON format for file output */
    jsonFormat?: boolean;
}
export declare class Logger {
    private options;
    private stream;
    private buffer;
    constructor(options?: LoggerOptions);
    private initFileStream;
    private shouldLog;
    private formatEntry;
    private write;
    debug(event: string, data?: Record<string, unknown>): void;
    info(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
    error(event: string, data?: Record<string, unknown>): void;
    logCrawlStart(baseUrl: string, options: Record<string, unknown>): void;
    logCrawlEnd(summary: Record<string, unknown>): void;
    logPageStart(url: string): void;
    logPageComplete(result: PageResult): void;
    logPageError(error: PageError): void;
    logAction(action: ActionResult): void;
    logBlockedNavigation(url: string): void;
    logProgress(visited: number, total: number): void;
    logRecovery(recovery: RecoveryInfo): void;
    logNavigationError(url: string, statusCode: number, error: string): void;
    getEntries(): LogEntry[];
    close(): Promise<void>;
}
/**
 * Create a no-op logger for when logging is disabled
 */
export declare function createNullLogger(): Logger;
//# sourceMappingURL=logger.d.ts.map