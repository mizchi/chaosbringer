/**
 * The docs' lists of the crawl flags `minimize` and `drive` take are the
 * tables in `cli-crawl-options.ts` (which their `--help` prints), not copies
 * that drift: a flag added to a table and not to its doc, or the other way
 * round, fails here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRIVE_CRAWL_FLAGS, REPLAY_CRAWL_FLAGS } from "./cli-crawl-options.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const DRIVE_MD = readFileSync(new URL("../../../docs/recipes/drive.md", import.meta.url), "utf8");

/** The `--flags` between `start` and `end` in `text`, in order. */
function flagsBetween(text: string, start: string, end: string): string[] {
  const from = text.indexOf(start);
  expect(from, `"${start}" is not in the doc`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `"${end}" does not follow "${start}"`).toBeGreaterThan(from);
  return [...text.slice(from + start.length, to).matchAll(/`--([a-z-]+)`/g)].map((m) => m[1]!);
}

describe("the docs list the crawl flags the tables hold", () => {
  it("README's minimize section lists REPLAY_CRAWL_FLAGS", () => {
    expect(flagsBetween(README, "Every replay runs with the crawl flags that shape a replay:", "(`REPLAY_CRAWL_FLAGS`")).toEqual([
      ...REPLAY_CRAWL_FLAGS,
    ]);
  });

  it("drive.md lists DRIVE_CRAWL_FLAGS", () => {
    expect(flagsBetween(DRIVE_MD, "`drive --help` prints the same list", "Where they fit a drive")).toEqual([
      ...DRIVE_CRAWL_FLAGS,
    ]);
  });
});
