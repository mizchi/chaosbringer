/**
 * Logger for Chaos Crawler
 *
 * Writes structured logs to file and/or console during execution.
 */
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
export class Logger {
    options;
    stream = null;
    buffer = [];
    constructor(options = {}) {
        this.options = {
            logFile: options.logFile || "",
            level: options.level || "info",
            console: options.console ?? false,
            jsonFormat: options.jsonFormat ?? true,
        };
        if (this.options.logFile) {
            this.initFileStream();
        }
    }
    initFileStream() {
        const dir = dirname(this.options.logFile);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.stream = createWriteStream(this.options.logFile, { flags: "a" });
    }
    shouldLog(level) {
        return LOG_LEVELS[level] >= LOG_LEVELS[this.options.level];
    }
    formatEntry(entry) {
        if (this.options.jsonFormat) {
            return JSON.stringify(entry);
        }
        const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
        return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.event}${dataStr}`;
    }
    write(level, event, data) {
        if (!this.shouldLog(level))
            return;
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            event,
            data,
        };
        this.buffer.push(entry);
        const formatted = this.formatEntry(entry);
        if (this.stream) {
            this.stream.write(formatted + "\n");
        }
        if (this.options.console) {
            const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
            consoleFn(formatted);
        }
    }
    // Public logging methods
    debug(event, data) {
        this.write("debug", event, data);
    }
    info(event, data) {
        this.write("info", event, data);
    }
    warn(event, data) {
        this.write("warn", event, data);
    }
    error(event, data) {
        this.write("error", event, data);
    }
    // Crawler-specific logging methods
    logCrawlStart(baseUrl, options) {
        this.info("crawl_start", { baseUrl, ...options });
    }
    logCrawlEnd(summary) {
        this.info("crawl_end", summary);
    }
    logPageStart(url) {
        this.info("page_start", { url });
    }
    logPageComplete(result) {
        this.info("page_complete", {
            url: result.url,
            status: result.status,
            statusCode: result.statusCode,
            loadTime: result.loadTime,
            errorCount: result.errors.length,
            linkCount: result.links.length,
        });
    }
    logPageError(error) {
        this.error("page_error", {
            type: error.type,
            message: error.message,
            url: error.url,
            stack: error.stack,
        });
    }
    logAction(action) {
        this.debug("action", {
            type: action.type,
            target: action.target,
            selector: action.selector,
            success: action.success,
            blockedExternal: action.blockedExternal,
            error: action.error,
        });
    }
    logBlockedNavigation(url) {
        this.warn("blocked_navigation", { url });
    }
    logProgress(visited, total) {
        this.debug("progress", { visited, total, percent: Math.round((visited / total) * 100) });
    }
    logRecovery(recovery) {
        this.warn("recovery", {
            failedUrl: recovery.failedUrl,
            error: recovery.error,
            recoveredTo: recovery.recoveredTo,
            recentActionsCount: recovery.recentActions.length,
            recentActions: recovery.recentActions.map((a) => ({
                type: a.type,
                target: a.target,
                success: a.success,
            })),
        });
    }
    logNavigationError(url, statusCode, error) {
        this.error("navigation_error", { url, statusCode, error });
    }
    // Get all buffered entries
    getEntries() {
        return [...this.buffer];
    }
    // Flush and close
    async close() {
        if (this.stream) {
            return new Promise((resolve) => {
                this.stream.end(() => {
                    this.stream = null;
                    resolve();
                });
            });
        }
    }
}
/**
 * Create a no-op logger for when logging is disabled
 */
export function createNullLogger() {
    return new Logger({ level: "error" });
}
