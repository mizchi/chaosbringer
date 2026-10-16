/**
 * What the main CLI says about itself rather than about a run.
 *
 * Out of `cli.ts`, which parses `process.argv` and exits as soon as it is
 * imported, so a test can call it.
 */
import { readFileSync } from "node:fs";

/**
 * The installed package's version, read from its package.json at run time
 * (`../package.json` from both `src/` and `dist/`), so it is the version the
 * package was published as, not one copied into the source.
 */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string") throw new Error("package.json has no version");
  return pkg.version;
}

/**
 * The one line a refused invocation prints. `err` is what `parseArgs`, the
 * flag parsers or `validateOptions` threw; they used to escape as a Node
 * stack trace.
 */
export function usageErrorMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  // parseArgs goes on to explain `--` for a positional that starts with a
  // "-", which a URL never does.
  if ((err as { code?: unknown } | null)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const known = /^Unknown option '([^']+)'/.exec(message);
    if (known) message = `unknown option ${known[1]}`;
  }
  // validateOptions' messages carry the prefix already.
  return `chaosbringer: ${message.replace(/^chaosbringer: /, "")} (see chaosbringer --help)`;
}
