import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface TerminalBrowserTarget {
  cdpEndpoint: string;
  cdpTargetId: string;
}

interface TabCandidate {
  url: URL;
  targetId: string;
  active: boolean;
  cdpPort: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function selectTerminalBrowserTarget(listing: unknown, baseUrl: string): TerminalBrowserTarget {
  const browsers = record(listing)?.browsers;
  if (!Array.isArray(browsers)) {
    throw new Error("chaosbringer: invalid JSON from terminal-browser ls --all --json");
  }

  const tabs: TabCandidate[] = [];
  for (const rawBrowser of browsers) {
    const browser = record(rawBrowser);
    if (!browser || !Array.isArray(browser.tabs)) continue;
    const cdpPort = typeof browser.cdpPort === "number" && Number.isInteger(browser.cdpPort)
      && browser.cdpPort >= 1 && browser.cdpPort <= 65535
      ? browser.cdpPort
      : null;
    for (const rawTab of browser.tabs) {
      const tab = record(rawTab);
      if (!tab || typeof tab.url !== "string" || typeof tab.targetId !== "string" || !tab.targetId) continue;
      try {
        tabs.push({ url: new URL(tab.url), targetId: tab.targetId, active: tab.active === true, cdpPort });
      } catch {
        continue;
      }
    }
  }

  const requested = new URL(baseUrl);
  const exact = tabs.filter((tab) => tab.url.href === requested.href);
  const matching = exact.length > 0 ? exact : tabs.filter((tab) => tab.url.origin === requested.origin);
  if (matching.length === 0) {
    throw new Error(`chaosbringer: no matching tab for ${baseUrl} in terminal-browser; open the URL first`);
  }
  const connectable = matching.filter((tab) => tab.cdpPort !== null);
  if (connectable.length === 0) {
    throw new Error(`chaosbringer: matching terminal-browser tab has no CDP port`);
  }
  const active = connectable.filter((tab) => tab.active);
  const candidates = active.length > 0 ? active : connectable;
  if (candidates.length !== 1) {
    throw new Error(`chaosbringer: multiple matching terminal-browser tabs for ${baseUrl}; pass --cdp and --cdp-target explicitly`);
  }
  return { cdpEndpoint: String(candidates[0]!.cdpPort), cdpTargetId: candidates[0]!.targetId };
}

export async function resolveTerminalBrowserTarget(baseUrl: string): Promise<TerminalBrowserTarget> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("terminal-browser", ["ls", "--all", "--json"], { timeout: 5000 }));
  } catch (error) {
    throw new Error(`chaosbringer: could not run terminal-browser ls --all --json: ${error instanceof Error ? error.message : String(error)}`);
  }
  let listing: unknown;
  try {
    listing = JSON.parse(stdout);
  } catch {
    throw new Error("chaosbringer: invalid JSON from terminal-browser ls --all --json");
  }
  return selectTerminalBrowserTarget(listing, baseUrl);
}
