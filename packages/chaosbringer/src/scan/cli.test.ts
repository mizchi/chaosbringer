import { describe, expect, it } from "vitest";
import { UsageError } from "../cli-usage.js";
import { parseScanArgs, scanOptionsFromCli } from "./cli.js";

const scanOptions = (argv: string[]) => scanOptionsFromCli(parseScanArgs(["--url", "http://127.0.0.1:9/", ...argv]).values);

// What only the crawler checked failed after `[scan] clean crawl of …` had
// started, as `scan failed: …` and exit 1: the code --fail-on gates on.
describe("scanOptionsFromCli", () => {
  it.each([
    [["--exclude", "("], '--exclude "(" is not a valid regex (Invalid regular expression: /(/: Unterminated group)'],
    [["--ignore-error", "[a-"], '--ignore-error "[a-" is not a valid regex (Invalid regular expression: /[a-/: Unterminated character class)'],
    // validateOptions refused it too, as `"device" "No Such Phone" …`, naming the option field.
    [["--device", "No Such Phone"], '--device "No Such Phone" is not a known Playwright device descriptor'],
    // Number("") is 0: `--seed "$SEED"` with SEED unset ran seed 0.
    [["--seed", ""], '--seed must be an integer >= 0 (got "")'],
  ])("refuses %j as a usage error before any crawl", (argv, message) => {
    expect(() => scanOptions(argv)).toThrow(UsageError);
    expect(() => scanOptions(argv)).toThrow(message);
  });

  it("leaves the files to runScanCli: a repro command's paths are where it ran", () => {
    expect(scanOptions(["--storage-state", "not-here.json"]).crawler?.storageState).toBe("not-here.json");
  });
});
