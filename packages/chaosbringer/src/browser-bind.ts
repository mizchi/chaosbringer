/**
 * Hand the browser chaosbringer is driving to another client, while it
 * drives.
 *
 * `browser.bind(title)` (Playwright 1.59) serves a launched browser on a
 * named pipe (or a web socket with `host`/`port`) that other Playwright
 * clients can join: the bundled `playwright-cli` (`npx playwright cli
 * attach <title>`) and MCP server (`npx playwright mcp --endpoint <endpoint>`)
 * among them. An agent attached that way sees the crawl's or drive's pages,
 * snapshots them, and can act on them: look at the state a failing step left
 * behind, or take over from where `drive` stopped (`keepOpen`).
 */

import type { Browser } from "playwright";

export interface BindOptions {
  /** How clients name it (`playwright-cli attach <title>`). Default `chaosbringer`. */
  title?: string;
  /** Serve a web socket on this host instead of a named pipe. */
  host?: string;
  /** Web socket port (0 = any free one). Implies a web socket. */
  port?: number;
}

export interface BoundBrowser {
  title: string;
  endpoint: string;
}

/** `bind` as the crawler and drive take it: `true` for the defaults, a string for a title. */
export type BindSpec = boolean | string | BindOptions;

export function resolveBind(spec: BindSpec | undefined): BindOptions | null {
  if (spec === undefined || spec === false) return null;
  if (spec === true) return {};
  if (typeof spec === "string") return { title: spec };
  return spec;
}

/** Bind `browser`, and say how to attach. */
export async function bindBrowser(browser: Browser, options: BindOptions, workspaceDir = process.cwd()): Promise<BoundBrowser> {
  const title = options.title ?? "chaosbringer";
  const { endpoint } = await browser.bind(title, {
    workspaceDir,
    metadata: { tool: "chaosbringer" },
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  return { title, endpoint };
}

/** What to type to join a bound browser. */
export function attachHint(b: BoundBrowser): string {
  return [
    `browser bound as "${b.title}" (${b.endpoint})`,
    `  attach from a terminal:  npx playwright cli attach ${b.title}   then  npx playwright cli -s=${b.title} snapshot`,
    `  attach an MCP client:    npx playwright mcp --endpoint ${b.endpoint}`,
  ].join("\n");
}

/** Resolve on Ctrl-C (or SIGTERM), for a run that keeps its browser open. */
export function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}
