import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { Logger, createNullLogger } from "./logger.js";

describe("Logger level filtering", () => {
  it("skips entries below the configured level", () => {
    const logger = new Logger({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    const levels = logger.getEntries().map((e) => e.level);
    expect(levels).toEqual(["warn", "error"]);
  });

  it("default level is info (debug filtered)", () => {
    const logger = new Logger();
    logger.debug("d");
    logger.info("i");
    const levels = logger.getEntries().map((e) => e.level);
    expect(levels).toEqual(["info"]);
  });

  it("records event name and data payload", () => {
    const logger = new Logger();
    logger.info("page_start", { url: "http://x/" });
    const [entry] = logger.getEntries();
    expect(entry.event).toBe("page_start");
    expect(entry.data).toEqual({ url: "http://x/" });
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("Logger file output", () => {
  it("writes one JSON entry per line", async () => {
    const path = join(tmpdir(), `chaos-log-${Date.now()}.log`);
    try {
      const logger = new Logger({ logFile: path, level: "debug" });
      logger.info("a", { n: 1 });
      logger.warn("b");
      await logger.close();

      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.event).toBe("a");
      expect(first.data).toEqual({ n: 1 });
      expect(first.level).toBe("info");
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("creates missing parent directories", async () => {
    const dir = join(tmpdir(), `chaos-nested-${Date.now()}`, "deep");
    const path = join(dir, "out.log");
    try {
      const logger = new Logger({ logFile: path });
      logger.info("hi");
      await logger.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });
});

describe("createNullLogger", () => {
  it("buffers only errors", () => {
    const logger = createNullLogger();
    logger.info("skipped");
    logger.error("kept");
    const levels = logger.getEntries().map((e) => e.level);
    expect(levels).toEqual(["error"]);
  });
});

describe("crawler-specific helpers", () => {
  it("logPageComplete emits a summarised payload", () => {
    const logger = new Logger();
    logger.logPageComplete({
      url: "http://x/",
      status: "success",
      statusCode: 200,
      loadTime: 42,
      errors: [],
      warnings: [],
      links: ["a", "b"],
    });
    const [entry] = logger.getEntries();
    expect(entry.event).toBe("page_complete");
    expect(entry.data).toMatchObject({
      url: "http://x/",
      status: "success",
      statusCode: 200,
      loadTime: 42,
      errorCount: 0,
      linkCount: 2,
    });
  });

  it("logBlockedNavigation uses warn level", () => {
    const logger = new Logger({ level: "debug" });
    logger.logBlockedNavigation("http://evil/");
    const [entry] = logger.getEntries();
    expect(entry.level).toBe("warn");
    expect(entry.event).toBe("blocked_navigation");
    expect(entry.data).toEqual({ url: "http://evil/" });
  });
});
