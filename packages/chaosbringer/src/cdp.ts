import type { Browser, Page } from "playwright";

export function cdpEndpointUrl(endpoint: string): string {
  if (/^\d+$/.test(endpoint)) {
    const port = Number(endpoint);
    if (port < 1 || port > 65535) {
      throw new Error("chaosbringer: cdpEndpoint port must be between 1 and 65535");
    }
    return `http://127.0.0.1:${port}`;
  }
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      throw new Error("invalid protocol");
    }
    return endpoint;
  } catch {
    throw new Error(
      `chaosbringer: cdpEndpoint must be a port or HTTP/WebSocket URL (got ${JSON.stringify(endpoint)})`,
    );
  }
}

export async function selectCdpPage(
  browser: Browser,
  baseUrl: string,
  targetId?: string,
): Promise<Page> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (targetId) {
    for (const page of pages) {
      let session;
      try {
        session = await page.context().newCDPSession(page);
        const result = await session.send("Target.getTargetInfo");
        if (result.targetInfo.targetId === targetId) return page;
      } catch {
        continue;
      } finally {
        await session?.detach().catch(() => {});
      }
    }
    throw new Error(`chaosbringer: no CDP page has target id ${targetId}`);
  }
  const targetUrl = new URL(baseUrl).href;
  const matches = pages.filter((page) => page.url() === targetUrl);
  if (matches.length === 1) return matches[0]!;
  if (pages.length === 1) return pages[0]!;
  throw new Error(`chaosbringer: CDP endpoint has ${pages.length} pages; pass cdpTargetId to select one`);
}
